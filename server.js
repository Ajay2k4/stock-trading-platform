const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const JWT_SECRET = 'stock_dashboard_secret_key_2024';
const PORT = process.env.PORT || 3000;

// ─── In-memory data store ────────────────────────────────────────────────────
const SUPPORTED_STOCKS = ['GOOG', 'TSLA', 'AMZN', 'META', 'NVDA'];

// Seed users (password: "password123" for both)
const users = [
  {
    id: uuidv4(),
    email: 'alice@example.com',
    password: bcrypt.hashSync('password123', 10),
    subscriptions: []
  },
  {
    id: uuidv4(),
    email: 'bob@example.com',
    password: bcrypt.hashSync('password123', 10),
    subscriptions: []
  }
];

// Current stock prices (initialized with realistic base prices)
const stockPrices = {
  GOOG: { price: 175.42, change: 0, changePercent: 0, prevPrice: 175.42 },
  TSLA: { price: 248.50, change: 0, changePercent: 0, prevPrice: 248.50 },
  AMZN: { price: 198.73, change: 0, changePercent: 0, prevPrice: 198.73 },
  META: { price: 512.30, change: 0, changePercent: 0, prevPrice: 512.30 },
  NVDA: { price: 875.60, change: 0, changePercent: 0, prevPrice: 875.60 }
};

// WebSocket clients: Map<ws, { userId, email, subscriptions }>
const clients = new Map();

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static('.')); // Serve static files (index.html, etc.)

// ─── Auth middleware ──────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ─── REST Routes ─────────────────────────────────────────────────────────────

// Login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password required' });

  const user = users.find(u => u.email === email.toLowerCase().trim());
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'Invalid email or password' });

  const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '24h' });
  res.json({
    token,
    user: { id: user.id, email: user.email, subscriptions: user.subscriptions }
  });
});

// Register (bonus - create new user)
app.post('/api/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password required' });

  if (users.find(u => u.email === email.toLowerCase().trim()))
    return res.status(409).json({ error: 'Email already registered' });

  const newUser = {
    id: uuidv4(),
    email: email.toLowerCase().trim(),
    password: bcrypt.hashSync(password, 10),
    subscriptions: []
  };
  users.push(newUser);

  const token = jwt.sign({ userId: newUser.id, email: newUser.email }, JWT_SECRET, { expiresIn: '24h' });
  res.status(201).json({
    token,
    user: { id: newUser.id, email: newUser.email, subscriptions: [] }
  });
});

// Get supported stocks
app.get('/api/stocks', authMiddleware, (req, res) => {
  res.json({ stocks: SUPPORTED_STOCKS, prices: stockPrices });
});

// Get user subscriptions
app.get('/api/subscriptions', authMiddleware, (req, res) => {
  const user = users.find(u => u.id === req.user.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ subscriptions: user.subscriptions });
});

// Subscribe to a stock
app.post('/api/subscribe', authMiddleware, (req, res) => {
  const { ticker } = req.body;
  if (!SUPPORTED_STOCKS.includes(ticker?.toUpperCase()))
    return res.status(400).json({ error: `Unsupported stock. Choose from: ${SUPPORTED_STOCKS.join(', ')}` });

  const user = users.find(u => u.id === req.user.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const upperTicker = ticker.toUpperCase();
  if (!user.subscriptions.includes(upperTicker)) {
    user.subscriptions.push(upperTicker);
    // Update WS client subscriptions if connected
    for (const [ws, clientData] of clients.entries()) {
      if (clientData.userId === user.id) {
        clientData.subscriptions = [...user.subscriptions];
      }
    }
  }
  res.json({ subscriptions: user.subscriptions, message: `Subscribed to ${upperTicker}` });
});

// Unsubscribe from a stock
app.delete('/api/subscribe/:ticker', authMiddleware, (req, res) => {
  const ticker = req.params.ticker?.toUpperCase();
  const user = users.find(u => u.id === req.user.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  user.subscriptions = user.subscriptions.filter(s => s !== ticker);
  // Update WS client subscriptions if connected
  for (const [ws, clientData] of clients.entries()) {
    if (clientData.userId === user.id) {
      clientData.subscriptions = [...user.subscriptions];
    }
  }
  res.json({ subscriptions: user.subscriptions, message: `Unsubscribed from ${ticker}` });
});

// ─── WebSocket Handler ────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  console.log('New WebSocket connection');

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'authenticate') {
        try {
          const decoded = jwt.verify(data.token, JWT_SECRET);
          const user = users.find(u => u.id === decoded.userId);
          if (!user) {
            ws.send(JSON.stringify({ type: 'error', message: 'User not found' }));
            return;
          }
          clients.set(ws, {
            userId: user.id,
            email: user.email,
            subscriptions: [...user.subscriptions]
          });
          ws.send(JSON.stringify({
            type: 'authenticated',
            message: 'Connected to live price feed',
            subscriptions: user.subscriptions
          }));
          console.log(`User ${user.email} connected via WebSocket`);
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid token' }));
        }
      }

      if (data.type === 'update_subscriptions') {
        const clientData = clients.get(ws);
        if (clientData) {
          clientData.subscriptions = data.subscriptions || [];
          clients.set(ws, clientData);
        }
      }
    } catch (err) {
      console.error('WS message error:', err.message);
    }
  });

  ws.on('close', () => {
    const clientData = clients.get(ws);
    if (clientData) console.log(`User ${clientData.email} disconnected`);
    clients.delete(ws);
  });

  ws.on('error', (err) => {
    console.error('WS error:', err.message);
    clients.delete(ws);
  });
});

// ─── Stock price simulator ────────────────────────────────────────────────────
function simulatePriceUpdate() {
  // Update all stock prices with random walk
  for (const ticker of SUPPORTED_STOCKS) {
    const stock = stockPrices[ticker];
    const volatility = 0.002; // 0.2% max change per tick
    const change = stock.price * volatility * (Math.random() * 2 - 1);
    const newPrice = Math.max(1, stock.price + change);

    stock.prevPrice = stock.price;
    stock.price = parseFloat(newPrice.toFixed(2));
    stock.change = parseFloat((stock.price - stock.prevPrice).toFixed(2));
    stock.changePercent = parseFloat(((stock.change / stock.prevPrice) * 100).toFixed(3));
    stock.timestamp = Date.now();
  }

  // Broadcast to all authenticated WS clients based on their subscriptions
  for (const [ws, clientData] of clients.entries()) {
    if (ws.readyState !== ws.OPEN) continue;

    const updates = {};
    for (const ticker of clientData.subscriptions) {
      if (stockPrices[ticker]) {
        updates[ticker] = stockPrices[ticker];
      }
    }

    if (Object.keys(updates).length > 0) {
      ws.send(JSON.stringify({
        type: 'price_update',
        prices: updates,
        timestamp: Date.now()
      }));
    }
  }
}

// Update prices every second
setInterval(simulatePriceUpdate, 1000);

// ─── Start server ─────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🚀 Stock Dashboard Server running on port ${PORT}`);
  console.log(`📡 REST API:    http://localhost:${PORT}/api`);
  console.log(`🔌 WebSocket:   ws://localhost:${PORT}`);
  console.log(`\n👤 Demo users:`);
  console.log(`   alice@example.com / password123`);
  console.log(`   bob@example.com   / password123\n`);
});
