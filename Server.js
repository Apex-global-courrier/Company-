/**
 * APEX-GLOBAL-SHIPPING — backend server
 * Plain Node.js (no npm install needed). Run with: node server.js
 * Serves the frontend from /public and a small JSON-file-backed API for
 * creating shipments, tracking them, and updating their status.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'shipments.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ---------------------------- storage helpers ---------------------------- */

function ensureDataFile() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ nextOrderId: 218, shipments: [] }, null, 2));
  }
}

function readDB() {
  ensureDataFile();
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function writeDB(db) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

function generateTrackingNumber(db) {
  let tracking;
  do {
    tracking = String(Math.floor(1000000000 + Math.random() * 8999999999));
  } while (db.shipments.some((s) => s.trackingNumber === tracking));
  return tracking;
}

/* ------------------------------ tiny helpers ------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

function sendJSON(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  let filePath = decodeURIComponent(req.url.split('?')[0]);
  if (filePath === '/') filePath = '/index.html';
  const fullPath = path.join(PUBLIC_DIR, filePath);

  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('404 — Not found');
    }
    const ext = path.extname(fullPath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

/* --------------------------------- server --------------------------------- */

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (req.method === 'OPTIONS') return sendJSON(res, 204, {});

  // POST /api/shipments — create a new shipment
  if (url === '/api/shipments' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { sender, receiver, parcel, costs, bookingMode } = body;

      if (!sender || !sender.name || !receiver || !receiver.name) {
        return sendJSON(res, 400, { error: 'Sender name and receiver name are required.' });
      }

      const db = readDB();
      const shippingCost = Number(costs && costs.shippingCost) || 0;
      const clearanceCost = Number(costs && costs.clearanceCost) || 0;

      const shipment = {
        orderId: db.nextOrderId,
        trackingNumber: generateTrackingNumber(db),
        createdAt: new Date().toISOString(),
        sender: {
          name: sender.name,
          phone: sender.phone || '',
          address: sender.address || '',
        },
        receiver: {
          name: receiver.name,
          phone: receiver.phone || '',
          address: receiver.address || '',
        },
        parcel: {
          description: (parcel && parcel.description) || 'General Parcel',
          quantity: (parcel && Number(parcel.quantity)) || 1,
        },
        costs: {
          shippingCost,
          clearanceCost,
          totalCost: Number((shippingCost + clearanceCost).toFixed(2)),
        },
        bookingMode: bookingMode === 'Prepaid' ? 'Prepaid' : 'ToPay',
        status: 'Processing',
        statusHistory: [{ status: 'Processing', at: new Date().toISOString() }],
      };

      db.nextOrderId += 1;
      db.shipments.push(shipment);
      writeDB(db);

      return sendJSON(res, 201, shipment);
    } catch (e) {
      return sendJSON(res, 400, { error: 'Invalid request body — expected JSON.' });
    }
  }

  // GET /api/shipments — list everything (handy for a teacher/demo check)
  if (url === '/api/shipments' && req.method === 'GET') {
    const db = readDB();
    return sendJSON(res, 200, db.shipments);
  }

  // PATCH /api/shipments/:tracking/status — move a shipment through its lifecycle
  const statusMatch = url.match(/^\/api\/shipments\/([^/]+)\/status$/);
  if (statusMatch && req.method === 'PATCH') {
    try {
      const body = await readBody(req);
      const allowed = ['Processing', 'In Transit', 'Delivered'];
      if (!allowed.includes(body.status)) {
        return sendJSON(res, 400, { error: `Status must be one of: ${allowed.join(', ')}` });
      }
      const db = readDB();
      const shipment = db.shipments.find((s) => s.trackingNumber === statusMatch[1]);
      if (!shipment) return sendJSON(res, 404, { error: 'No shipment found for that tracking number.' });

      shipment.status = body.status;
      shipment.statusHistory.push({ status: body.status, at: new Date().toISOString() });
      writeDB(db);
      return sendJSON(res, 200, shipment);
    } catch (e) {
      return sendJSON(res, 400, { error: 'Invalid request body — expected JSON.' });
    }
  }

  // GET /api/shipments/:tracking — look up a single shipment
  const trackMatch = url.match(/^\/api\/shipments\/([^/]+)$/);
  if (trackMatch && req.method === 'GET') {
    const db = readDB();
    const shipment = db.shipments.find((s) => s.trackingNumber === trackMatch[1]);
    if (!shipment) return sendJSON(res, 404, { error: 'No shipment found for that tracking number.' });
    return sendJSON(res, 200, shipment);
  }

  if (url.startsWith('/api/')) return sendJSON(res, 404, { error: 'Unknown API route.' });

  return serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`APEX-GLOBAL-SHIPPING backend running → http://localhost:${PORT}`);
  console.log('Frontend and API are served from the same origin — no CORS setup needed.');
});
