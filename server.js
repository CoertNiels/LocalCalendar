const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const Database = require('better-sqlite3');
const WebSocket = require('ws');
const http = require('http');

const app = express();
const PORT = 8080;
const HOST = '0.0.0.0';

// Create HTTP server instance
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Keep track of connected clients
const clients = new Set();

// Initialize SQLite DB connection with database.db
let db;
try {
  db = new Database('database.db', { 
    verbose: console.log,
    fileMustExist: false // Create if not exists
  });

  // Enable foreign keys
  db.pragma('foreign_keys = ON');

  // Create tables if they don't exist
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ip TEXT UNIQUE NOT NULL,
        name TEXT UNIQUE NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        title TEXT NOT NULL,
        details TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      -- Create indexes for better query performance
      CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);
      CREATE INDEX IF NOT EXISTS idx_events_user_id ON events(user_id);
    `);
  })();
} catch (err) {
  console.error('Database initialization error:', err);
  process.exit(1);
}

// Middleware
app.use(cookieParser());
app.use(express.json());

// API authentication middleware
const authenticateUser = (req, res, next) => {
  try {
    // Get user from IP
    const ip = getClientIp(req);
    const stmt = db.prepare('SELECT id, name FROM users WHERE ip = ?');
    const user = stmt.get(ip);
    
    if (!user) {
      return res.status(403).json({
        error: 'Unauthorized',
        message: 'Please login or register first',
        code: 'AUTH_REQUIRED'
      });
    }
    
    // Attach user to request for use in route handlers
    req.user = user;
    next();
  } catch (err) {
    console.error('Authentication error:', err);
    res.status(500).json({
      error: 'Authentication failed',
      message: 'Internal server error',
      code: 'AUTH_ERROR'
    });
  }
};

// API routes middleware
app.use('/api', (req, res, next) => {
  // Check if request is coming from a browser
  const acceptHeader = req.headers.accept || '';
  const isDirectBrowserAccess = acceptHeader.includes('text/html');
  
  // If it's a direct browser request, redirect to home page
  if (isDirectBrowserAccess) {
    return res.redirect('/');
  }

  // Public routes that don't require authentication
  const publicRoutes = [
    { path: '/user', methods: ['GET', 'POST'] }
  ];
  
  // Check if the current request matches any public route
  const isPublicRoute = publicRoutes.some(route => 
    req.path === route.path && route.methods.includes(req.method)
  );
  
  if (isPublicRoute) {
    return next();
  }
  
  // Require authentication for all other API routes
  authenticateUser(req, res, next);
});

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
  console.log('[POST /api/events] IP:', ip, 'Body:', req.body);

  const { date, title, details } = req.body;
  if (!date || !title || typeof date !== 'string' || typeof title !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid date/title' });
  }
  const trimmedTitle = title.trim();
  const trimmedDetails = typeof details === 'string' ? details.trim() : '';
  const trimmedDate = date.trim();

  // User authentication is handled by middleware
  const user = req.user;

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
  const eventId = parseInt(req.params.id, 10);
  console.log(`[PUT /api/events/${eventId}] IP:`, ip, 'Body:', req.body);

  if (isNaN(eventId) || eventId < 1) {
    return res.status(400).json({ error: 'Invalid event ID. Must be a positive integer.' });
  }

  const { date, title, details } = req.body;
  if (!date || !title || typeof date !== 'string' || typeof title !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid date/title' });
  }
  const trimmedTitle = title.trim();
  const trimmedDetails = typeof details === 'string' ? details.trim() : '';
  const trimmedDate = date.trim();

  // User authentication is handled by middleware
  const user = req.user;

  // Check if event exists and belongs to this user
  const eventStmt = db.prepare('SELECT * FROM events WHERE id = ?');
  const event = eventStmt.get(eventId);
  if (!event) {
    return res.status(404).json({
      error: 'Not Found',
      message: 'Event does not exist',
      code: 'EVENT_NOT_FOUND'
    });
  }
  if (event.user_id !== user.id) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'You do not have permission to access this event',
      code: 'EVENT_ACCESS_DENIED'
    });
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
  const eventId = parseInt(req.params.id, 10);
  console.log(`[DELETE /api/events/${eventId}] IP: ${ip}`);

  if (isNaN(eventId) || eventId < 1) {
    return res.status(400).json({ error: 'Invalid event ID. Must be a positive integer.' });
  }

  // User authentication is handled by middleware
  const user = req.user;

  // Check if event exists and belongs to this user
  const eventStmt = db.prepare('SELECT * FROM events WHERE id = ?');
  const event = eventStmt.get(eventId);
  if (!event) {
    return res.status(404).json({
      error: 'Not Found',
      message: 'Event does not exist',
      code: 'EVENT_NOT_FOUND'
    });
  }
  if (event.user_id !== user.id) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'You do not have permission to access this event',
      code: 'EVENT_ACCESS_DENIED'
    });
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
  try {
    const message = JSON.stringify({ type, data });
    clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  } catch (err) {
    console.error('Error broadcasting update:', err);
  }
}

// Helper function to serve error page with custom status code
function serveErrorPage(res, statusCode) {
  const title = '404 - Page Not Found';
  const message = 'The page you\'re looking for doesn\'t exist. You may have mistyped the address or the page may have moved.';

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            background: #f9f9f9;
            margin: 0;
            padding: 20px;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            box-sizing: border-box;
        }
        .container {
            background: white;
            padding: 40px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            text-align: center;
            max-width: 500px;
            width: 100%;
        }
        h1 {
            color: #444;
            margin: 0 0 20px;
            font-size: 32px;
        }
        p {
            color: #666;
            margin: 0 0 25px;
            font-size: 16px;
            line-height: 1.5;
        }
        a {
            display: inline-block;
            background: #007bff;
            color: white;
            text-decoration: none;
            padding: 12px 24px;
            border-radius: 4px;
            font-size: 16px;
            transition: background-color 0.2s;
        }
        a:hover {
            background: #0056b3;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>${title}</h1>
        <p>${message}</p>
        <a href="/">Go Back to Homepage</a>
    </div>
</body>
</html>`;

  res.status(statusCode).send(html);
}

// 404 handler middleware - must be last route handler
app.use((req, res) => {
  serveErrorPage(res, 404);
});

// Start the server listening on 192.168.2.12:8080
server.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
});