const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const Database = require('better-sqlite3');
const WebSocket = require('ws');
const http = require('http');

const app = express();
const PORT = 8080;
const HOST = '192.168.2.12';

// Create HTTP server instance
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Keep track of connected clients
const clients = new Set();

// Initialize SQLite DB connection with database.db
const db = new Database('database.db', { verbose: console.log });

// Create tables if they don't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT UNIQUE,
    name TEXT UNIQUE
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    date TEXT,
    title TEXT,
    details TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
`);

// Middleware
app.use(cookieParser());
app.use(express.json());

// Serve the single index.html file with inline CSS/JS on /
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Improved IP detection helper with x-forwarded-for fallback
function getClientIp(req) {
  const xForwardedFor = req.headers['x-forwarded-for'];
  let ip = '';
  if (xForwardedFor) {
    ip = xForwardedFor.split(',')[0].trim();
  } else if (req.ip) {
    ip = req.ip;
  } else if (req.connection && req.connection.remoteAddress) {
    ip = req.connection.remoteAddress;
  }
  // Normalize IPv4-mapped IPv6 addresses
  if (ip.startsWith('::ffff:')) ip = ip.substring(7);
  return ip;
}

// API endpoint: GET /api/user
app.get('/api/user', (req, res) => {
  const ip = getClientIp(req);
  console.log(`[GET /api/user] IP: ${ip}`);
  const stmt = db.prepare('SELECT id, name FROM users WHERE ip = ?');
  const user = stmt.get(ip);
  res.json(user || {});
});

// API endpoint: POST /api/user
app.post('/api/user', (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Invalid or missing name' });
  }
  const trimmedName = name.trim();
  const ip = getClientIp(req);
  console.log(`[POST /api/user] IP: ${ip} Name: ${trimmedName}`);

  // Check if name already exists
  const existingNameStmt = db.prepare('SELECT id FROM users WHERE name = ?');
  if (existingNameStmt.get(trimmedName)) {
    return res.status(409).json({ error: 'Name already taken' });
  }

  // Insert new user with IP and name
  try {
    const insertStmt = db.prepare('INSERT INTO users (ip, name) VALUES (?, ?)');
    const info = insertStmt.run(ip, trimmedName);
    res.status(201).json({ id: info.lastInsertRowid, name: trimmedName });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'IP already registered with a user' });
    }
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// API endpoint: GET /api/events
app.get('/api/events', (req, res) => {
  const ip = getClientIp(req);
  console.log(`[GET /api/events] IP: ${ip}`);

  const stmt = db.prepare(`
    SELECT events.id, events.date, events.title, events.details, users.name as username
    FROM events
    JOIN users ON events.user_id = users.id
    ORDER BY events.date, events.id
  `);
  try {
    const events = stmt.all();
    res.json(events);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// API endpoint: POST /api/events
app.post('/api/events', (req, res) => {
  const ip = getClientIp(req);
  console.log(`[POST /api/events] IP: ${ip} Body: ${JSON.stringify(req.body)}`);

  const { date, title, details } = req.body;
  if (!date || !title || typeof date !== 'string' || typeof title !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid date/title' });
  }
  const trimmedTitle = title.trim();
  const trimmedDetails = typeof details === 'string' ? details.trim() : '';
  const trimmedDate = date.trim();

  // Get user_id from IP
  const userStmt = db.prepare('SELECT id, name FROM users WHERE ip = ?');
  const user = userStmt.get(ip);
  if (!user) {
    return res.status(403).json({ error: 'User not authenticated' });
  }

  try {
    const insertStmt = db.prepare(`
      INSERT INTO events (user_id, date, title, details)
      VALUES (?, ?, ?, ?)
    `);
    const info = insertStmt.run(user.id, trimmedDate, trimmedTitle, trimmedDetails);

    const newEvent = {
      id: info.lastInsertRowid,
      user_id: user.id,
      date: trimmedDate,
      title: trimmedTitle,
      details: trimmedDetails,
      username: user.name
    };

    // Broadcast the new event to all connected clients
    broadcastUpdate('event-created', newEvent);

    // Return the created event with username
    res.status(201).json(newEvent);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// API endpoint: PUT /api/events/:id
app.put('/api/events/:id', (req, res) => {
  const ip = getClientIp(req);
  const eventId = Number(req.params.id);
  console.log(`[PUT /api/events/${eventId}] IP: ${ip} Body: ${JSON.stringify(req.body)}`);

  if (isNaN(eventId)) {
    return res.status(400).json({ error: 'Invalid event ID' });
  }

  const { date, title, details } = req.body;
  if (!date || !title || typeof date !== 'string' || typeof title !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid date/title' });
  }
  const trimmedTitle = title.trim();
  const trimmedDetails = typeof details === 'string' ? details.trim() : '';
  const trimmedDate = date.trim();

  // Get user_id from IP
  const userStmt = db.prepare('SELECT id, name FROM users WHERE ip = ?');
  const user = userStmt.get(ip);
  if (!user) {
    return res.status(403).json({ error: 'User not authenticated' });
  }

  // Check if event exists and belongs to this user
  const eventStmt = db.prepare('SELECT * FROM events WHERE id = ?');
  const event = eventStmt.get(eventId);
  if (!event) {
    return res.status(404).json({ error: 'Event not found' });
  }
  if (event.user_id !== user.id) {
    return res.status(403).json({ error: 'Unauthorized to edit this event' });
  }

  try {
    const updateStmt = db.prepare(`
      UPDATE events SET date = ?, title = ?, details = ? WHERE id = ?
    `);
    updateStmt.run(trimmedDate, trimmedTitle, trimmedDetails, eventId);

    const updatedEvent = {
      id: eventId,
      user_id: user.id,
      date: trimmedDate,
      title: trimmedTitle,
      details: trimmedDetails,
      username: user.name
    };

    // Broadcast the updated event to all connected clients
    broadcastUpdate('event-updated', updatedEvent);

    // Return updated event with username
    res.json(updatedEvent);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// API endpoint: DELETE /api/events/:id
app.delete('/api/events/:id', (req, res) => {
  const ip = getClientIp(req);
  const eventId = Number(req.params.id);
  console.log(`[DELETE /api/events/${eventId}] IP: ${ip}`);

  if (isNaN(eventId)) {
    return res.status(400).json({ error: 'Invalid event ID' });
  }

  // Get user_id from IP
  const userStmt = db.prepare('SELECT id FROM users WHERE ip = ?');
  const user = userStmt.get(ip);
  if (!user) {
    return res.status(403).json({ error: 'User not authenticated' });
  }

  // Check if event exists and belongs to this user
  const eventStmt = db.prepare('SELECT * FROM events WHERE id = ?');
  const event = eventStmt.get(eventId);
  if (!event) {
    return res.status(404).json({ error: 'Event not found' });
  }
  if (event.user_id !== user.id) {
    return res.status(403).json({ error: 'Unauthorized to delete this event' });
  }

  try {
    const deleteStmt = db.prepare('DELETE FROM events WHERE id = ?');
    deleteStmt.run(eventId);

    // Broadcast the deleted event to all connected clients
    broadcastUpdate('event-deleted', { id: eventId });
    
    res.json({ message: 'Event deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  // Add new client to our set
  clients.add(ws);
  console.log(`New WebSocket connection: ${getClientIp(req)}`);

  // Handle client disconnection
  ws.on('close', () => {
    clients.delete(ws);
    console.log(`Client disconnected: ${getClientIp(req)}`);
  });
});

// Helper function to broadcast updates to all connected clients
function broadcastUpdate(type, data) {
  const message = JSON.stringify({ type, data });
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// 404 handler middleware - must be last route handler
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, '404.html'));
});

// Start the server listening on 192.168.2.12:8080
server.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
});
