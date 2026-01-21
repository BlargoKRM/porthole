const http = require('http');
const https = require('https');
const net = require('net');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Load configuration
const configPath = path.join(__dirname, 'config.json');
if (!fs.existsSync(configPath)) {
  console.error('Error: config.json not found');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const { serverPort, ngrok: ngrokConfig, portRanges, quickLaunch = [] } = config;

// Track active tunnels for individual services
const activeTunnels = new Map(); // port -> { process, url }

// Generate list of ports to scan from ranges
function getPortsToScan() {
  const ports = [];
  for (const [start, end] of portRanges) {
    for (let port = start; port <= end; port++) {
      ports.push(port);
    }
  }
  return ports;
}

// Check if a single port is open
function checkPort(port, timeout = 100) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;

    socket.setTimeout(timeout);

    socket.on('connect', () => {
      resolved = true;
      socket.destroy();
      resolve(true);
    });

    socket.on('timeout', () => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        resolve(false);
      }
    });

    socket.on('error', () => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        resolve(false);
      }
    });

    socket.connect(port, '127.0.0.1');
  });
}

// Get process info for a port using lsof
function getProcessInfo(port) {
  try {
    const output = execSync(`lsof -i :${port} -P -n | grep LISTEN`, {
      encoding: 'utf8',
      timeout: 5000,
    });
    const lines = output.trim().split('\n');
    if (lines.length > 0) {
      const parts = lines[0].split(/\s+/);
      return {
        name: parts[0] || 'unknown',
        pid: parts[1] || null,
      };
    }
  } catch (e) {
    // lsof failed or no process found
  }
  return { name: 'unknown', pid: null };
}

// Scan all configured ports
async function scanPorts() {
  const portsToScan = getPortsToScan();
  const results = [];

  // Scan ports in parallel batches to avoid overwhelming the system
  const batchSize = 50;
  for (let i = 0; i < portsToScan.length; i += batchSize) {
    const batch = portsToScan.slice(i, i + batchSize);
    const checks = await Promise.all(
      batch.map(async (port) => {
        // Skip our own port
        if (port === serverPort) return null;
        const isOpen = await checkPort(port);
        if (isOpen) {
          const processInfo = getProcessInfo(port);
          return { port, ...processInfo };
        }
        return null;
      })
    );
    results.push(...checks.filter(Boolean));
  }

  return results;
}

// Kill a process by port
function killByPort(port) {
  try {
    const output = execSync(`lsof -i :${port} -P -n -t`, {
      encoding: 'utf8',
      timeout: 5000,
    });
    const pids = output.trim().split('\n').filter(Boolean);
    for (const pid of pids) {
      execSync(`kill -9 ${pid}`);
    }
    return { success: true, message: `Killed process(es) on port ${port}` };
  } catch (e) {
    return { success: false, message: `Failed to kill process on port ${port}: ${e.message}` };
  }
}

// Build traffic policy for OAuth protection
function buildTrafficPolicy() {
  const allowedDomain = ngrokConfig.allowedEmailDomain || '@gmail.com';
  return {
    on_http_request: [
      {
        actions: [
          {
            type: 'oauth',
            config: {
              provider: 'google'
            }
          }
        ]
      },
      {
        expressions: [
          `!actions.ngrok.oauth.identity.email.endsWith('${allowedDomain}')`
        ],
        actions: [
          {
            type: 'deny',
            config: {
              status_code: 403
            }
          }
        ]
      }
    ]
  };
}

// Create a tunnel for a specific port using ngrok local API
// Note: Traffic policies can't be set via local API, but all tunnels go through
// the same ngrok agent which requires authentication
async function createTunnel(port) {
  // Check if we already have a tunnel for this port
  const existingUrl = await getNgrokTunnelUrl(port);
  if (existingUrl) {
    activeTunnels.set(port, { url: existingUrl });
    return { success: true, url: existingUrl, message: 'Tunnel already exists' };
  }

  return new Promise((resolve) => {
    // Generate a unique subdomain based on port to avoid URL reuse
    const subdomain = `porthole-${port}`;
    
    const tunnelConfig = {
      addr: `http://localhost:${port}`,
      proto: 'http',
      name: `porthole-${port}`,
      subdomain: subdomain,  // Request unique subdomain per port
    };
    
    const postData = JSON.stringify(tunnelConfig);

    const req = http.request({
      hostname: '127.0.0.1',
      port: 4040,
      path: '/api/tunnels',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.public_url) {
            // Prefer https URL
            const url = result.public_url.startsWith('https') 
              ? result.public_url 
              : result.public_url.replace('http://', 'https://');
            activeTunnels.set(port, { url });
            resolve({ success: true, url });
          } else if (result.error_code) {
            resolve({ success: false, message: result.msg || 'Failed to create tunnel' });
          } else {
            resolve({ success: false, message: 'Unexpected response from ngrok' });
          }
        } catch (e) {
          resolve({ success: false, message: `Parse error: ${e.message}` });
        }
      });
    });

    req.on('error', (err) => {
      resolve({ success: false, message: `ngrok API error: ${err.message}` });
    });

    req.setTimeout(5000, () => {
      req.destroy();
      resolve({ success: false, message: 'Timeout connecting to ngrok API' });
    });

    req.write(postData);
    req.end();
  });
}

// Get tunnel URL from ngrok local API
function getNgrokTunnelUrl(port) {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:4040/api/tunnels', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const tunnels = JSON.parse(data);
          const tunnel = tunnels.tunnels?.find(t => 
            t.config?.addr?.includes(`:${port}`) && t.public_url?.startsWith('https')
          );
          resolve(tunnel?.public_url || null);
        } catch (e) {
          resolve(null);
        }
      });
    });
    
    req.on('error', () => resolve(null));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(null);
    });
  });
}

// Launch a quick launch command
function launchCommand(index) {
  const cmd = quickLaunch[index];
  if (!cmd) {
    return { success: false, message: 'Invalid command index' };
  }
  
  try {
    // Split command into parts
    const parts = cmd.command.split(' ');
    const executable = parts[0];
    const args = parts.slice(1);
    
    // Spawn detached so it keeps running after we return
    const child = spawn(executable, args, {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    
    return { success: true, message: `Started: ${cmd.name}` };
  } catch (e) {
    return { success: false, message: `Failed to start ${cmd.name}: ${e.message}` };
  }
}

// HTML template for the UI
function getHtmlPage(tunnelUrl) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Porthole - Local Services</title>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: #1a1a2e;
      color: #eee;
      min-height: 100vh;
      padding: 20px;
    }
    .container {
      max-width: 800px;
      margin: 0 auto;
    }
    h1 {
      font-size: 1.75rem;
      margin-bottom: 5px;
      color: #fff;
    }
    .subtitle {
      color: #888;
      margin-bottom: 20px;
      font-size: 0.9rem;
    }
    .tunnel-info {
      background: #16213e;
      border: 1px solid #0f3460;
      border-radius: 8px;
      padding: 12px 15px;
      margin-bottom: 15px;
      font-size: 0.9rem;
      word-break: break-all;
    }
    .tunnel-info a {
      color: #4ecca3;
      text-decoration: none;
    }
    .btn {
      padding: 10px 16px;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      transition: all 0.2s;
      touch-action: manipulation;
    }
    .btn-kill {
      background: #e94560;
      color: white;
    }
    .btn-refresh {
      background: #4ecca3;
      color: #1a1a2e;
      font-weight: 600;
      width: 100%;
      margin-top: 15px;
      padding: 14px;
      font-size: 16px;
    }
    .btn-launch {
      background: #58a6ff;
      color: white;
    }
    .btn-tunnel {
      background: #9b59b6;
      color: white;
    }
    .quick-launch {
      background: #16213e;
      border: 1px solid #0f3460;
      border-radius: 8px;
      padding: 12px 15px;
      margin-bottom: 15px;
    }
    .quick-launch h3 {
      color: #4ecca3;
      margin-bottom: 10px;
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .quick-launch-buttons {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .loading, .empty {
      text-align: center;
      padding: 40px 20px;
      color: #888;
    }
    
    /* Service Cards - Mobile First */
    .services-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .service-card {
      background: #16213e;
      border: 1px solid #0f3460;
      border-radius: 10px;
      padding: 15px;
    }
    .service-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }
    .service-port {
      font-family: 'SF Mono', Monaco, monospace;
      font-size: 1.25rem;
      font-weight: 700;
      color: #4ecca3;
    }
    .service-process {
      font-family: 'SF Mono', Monaco, monospace;
      font-size: 0.85rem;
      color: #888;
      background: #0f3460;
      padding: 4px 10px;
      border-radius: 4px;
    }
    .tunnel-url {
      background: #2d1f3d;
      border: 1px dashed #9b59b6;
      border-radius: 6px;
      padding: 10px 12px;
      margin-bottom: 12px;
      font-family: 'SF Mono', Monaco, monospace;
      font-size: 0.8rem;
      color: #b07cc6;
      word-break: break-all;
      cursor: pointer;
      text-align: center;
    }
    .tunnel-url:active {
      background: #3d2f4d;
    }
    .service-links {
      display: flex;
      gap: 10px;
      margin-bottom: 12px;
    }
    .service-links a {
      flex: 1;
      display: block;
      text-align: center;
      padding: 12px;
      background: #0f3460;
      color: #58a6ff;
      text-decoration: none;
      border-radius: 6px;
      font-weight: 500;
      font-size: 0.95rem;
    }
    .service-links a.tunnel-link {
      background: #2d1f3d;
      color: #b07cc6;
    }
    .service-actions {
      display: flex;
      gap: 8px;
    }
    .service-actions .btn {
      flex: 1;
      padding: 12px;
    }
    
    /* Modal */
    .modal-overlay {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0,0,0,0.8);
      justify-content: center;
      align-items: center;
      z-index: 1000;
      padding: 20px;
    }
    .modal {
      background: #16213e;
      border: 1px solid #0f3460;
      border-radius: 12px;
      padding: 25px;
      width: 100%;
      max-width: 350px;
      text-align: center;
    }
    .modal h2 {
      margin-bottom: 12px;
      color: #e94560;
      font-size: 1.25rem;
    }
    .modal p {
      margin-bottom: 20px;
      color: #aaa;
      font-size: 0.95rem;
    }
    .modal-buttons {
      display: flex;
      gap: 10px;
    }
    .modal-buttons .btn {
      flex: 1;
      padding: 14px;
    }
    .btn-cancel {
      background: #333;
      color: #fff;
    }
    .btn-confirm {
      background: #e94560;
      color: white;
    }
    
    /* Notification */
    .notification {
      position: fixed;
      bottom: 20px;
      left: 20px;
      right: 20px;
      padding: 15px 20px;
      border-radius: 8px;
      color: white;
      font-weight: 500;
      text-align: center;
      transform: translateY(100px);
      opacity: 0;
      transition: all 0.3s;
      z-index: 1001;
    }
    .notification.show {
      transform: translateY(0);
      opacity: 1;
    }
    .notification.success {
      background: #4ecca3;
      color: #1a1a2e;
    }
    .notification.error {
      background: #e94560;
    }

    /* Desktop styles */
    @media (min-width: 600px) {
      body {
        padding: 40px 20px;
      }
      h1 {
        font-size: 2rem;
      }
      .service-card {
        padding: 20px;
      }
      .service-header {
        margin-bottom: 15px;
      }
      .service-links {
        margin-bottom: 15px;
      }
      .notification {
        left: auto;
        right: 20px;
        max-width: 350px;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Porthole</h1>
    <p class="subtitle">A window into your local ports</p>
    
    <div class="tunnel-info">
      <strong>Tunnel:</strong> <a href="${tunnelUrl}" target="_blank">${tunnelUrl}</a>
    </div>

    <div id="quick-launch" class="quick-launch"></div>

    <div id="services-container">
      <div class="loading">Scanning ports...</div>
    </div>

    <button class="btn btn-refresh" onclick="loadServices()">Refresh</button>
  </div>

  <div class="modal-overlay" id="modal-overlay">
    <div class="modal">
      <h2>Kill Process?</h2>
      <p id="modal-message">Are you sure you want to kill the process on port 3000?</p>
      <div class="modal-buttons">
        <button class="btn btn-cancel" onclick="closeModal()">Cancel</button>
        <button class="btn btn-confirm" onclick="confirmKill()">Kill</button>
      </div>
    </div>
  </div>

  <div class="notification" id="notification"></div>

  <script>
    let portToKill = null;

    let activeTunnels = {};
    const baseUrl = '${tunnelUrl}';

    async function loadServices() {
      const container = document.getElementById('services-container');
      container.innerHTML = '<div class="loading">Scanning ports...</div>';

      try {
        // Load ports and tunnels in parallel
        const [portsRes, tunnelsRes] = await Promise.all([
          fetch('/api/ports'),
          fetch('/api/tunnels')
        ]);
        const ports = await portsRes.json();
        activeTunnels = await tunnelsRes.json();

        if (ports.length === 0) {
          container.innerHTML = '<div class="empty">No services found on common development ports.</div>';
          return;
        }

        let html = '<div class="services-list">';

        for (const service of ports) {
          const proxyUrl = \`\${baseUrl}/proxy/\${service.port}/\`;
          const tunnelUrl = activeTunnels[service.port];
          
          let linksHtml = \`<a href="\${proxyUrl}">Proxy</a>\`;
          if (tunnelUrl) {
            linksHtml += \`<a href="\${tunnelUrl}" class="tunnel-link">Tunnel</a>\`;
          }
          
          let actionsHtml = \`<button class="btn btn-kill" onclick="showKillModal(\${service.port}, '\${service.name}')">Kill</button>\`;
          if (!tunnelUrl) {
            actionsHtml += \`<button class="btn btn-tunnel" onclick="createTunnel(\${service.port})">Tunnel</button>\`;
          }
          
          // Show tunnel URL if exists
          let tunnelInfoHtml = '';
          if (tunnelUrl) {
            const shortUrl = tunnelUrl.replace('https://', '');
            tunnelInfoHtml = \`<div class="tunnel-url" onclick="copyToClipboard('\${tunnelUrl}')">\${shortUrl}</div>\`;
          }
          
          html += \`
            <div class="service-card">
              <div class="service-header">
                <span class="service-port">\${service.port}</span>
                <span class="service-process">\${service.name}</span>
              </div>
              \${tunnelInfoHtml}
              <div class="service-links">\${linksHtml}</div>
              <div class="service-actions">\${actionsHtml}</div>
            </div>
          \`;
        }

        html += '</div>';
        container.innerHTML = html;
      } catch (e) {
        container.innerHTML = '<div class="empty">Error loading services. Please try again.</div>';
      }
    }

    async function createTunnel(port) {
      showNotification(\`Creating tunnel for port \${port}...\`, 'success');
      try {
        const res = await fetch(\`/api/tunnel/\${port}\`, { method: 'POST' });
        const result = await res.json();
        
        if (result.success) {
          showNotification(\`Tunnel created!\`, 'success');
          // Auto-open the tunnel URL in a new tab
          window.open(result.url, '_blank');
          loadServices();
        } else {
          showNotification(result.message, 'error');
        }
      } catch (e) {
        showNotification('Failed to create tunnel', 'error');
      }
    }

    function showKillModal(port, processName) {
      portToKill = port;
      document.getElementById('modal-message').textContent = 
        \`Are you sure you want to kill \${processName} on port \${port}?\`;
      document.getElementById('modal-overlay').style.display = 'flex';
    }

    function closeModal() {
      document.getElementById('modal-overlay').style.display = 'none';
      portToKill = null;
    }

    async function confirmKill() {
      if (!portToKill) return;
      
      const port = portToKill;
      closeModal();

      try {
        const res = await fetch(\`/api/kill/\${port}\`, { method: 'POST' });
        const result = await res.json();
        
        showNotification(result.message, result.success ? 'success' : 'error');
        
        if (result.success) {
          setTimeout(loadServices, 500);
        }
      } catch (e) {
        showNotification('Failed to kill process', 'error');
      }
    }

    function showNotification(message, type) {
      const notif = document.getElementById('notification');
      notif.textContent = message;
      notif.className = \`notification \${type} show\`;
      
      setTimeout(() => {
        notif.className = 'notification';
      }, 3000);
    }

    async function copyToClipboard(text) {
      try {
        await navigator.clipboard.writeText(text);
        showNotification('Copied to clipboard!', 'success');
      } catch (e) {
        showNotification('Failed to copy', 'error');
      }
    }

    async function loadQuickLaunch() {
      const container = document.getElementById('quick-launch');
      try {
        const res = await fetch('/api/commands');
        const commands = await res.json();
        
        if (commands.length === 0) {
          container.style.display = 'none';
          return;
        }

        let html = '<h3>Quick Launch</h3><div class="quick-launch-buttons">';
        commands.forEach((cmd, index) => {
          html += \`<button class="btn btn-launch" onclick="launchCommand(\${index}, '\${cmd.name}')">\${cmd.name}</button>\`;
        });
        html += '</div>';
        container.innerHTML = html;
      } catch (e) {
        container.style.display = 'none';
      }
    }

    async function launchCommand(index, name) {
      try {
        const res = await fetch(\`/api/launch/\${index}\`, { method: 'POST' });
        const result = await res.json();
        showNotification(result.message, result.success ? 'success' : 'error');
        
        if (result.success) {
          // Refresh services after a short delay to show the new process
          setTimeout(loadServices, 1500);
        }
      } catch (e) {
        showNotification(\`Failed to start \${name}\`, 'error');
      }
    }

    // Load on page load
    loadQuickLaunch();
    loadServices();
  </script>
</body>
</html>`;
}

// Create HTTP server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${serverPort}`);

  // API: Get active ports
  if (url.pathname === '/api/ports' && req.method === 'GET') {
    const ports = await scanPorts();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ports));
    return;
  }

  // API: Kill process by port
  if (url.pathname.startsWith('/api/kill/') && req.method === 'POST') {
    const portMatch = url.pathname.match(/\/api\/kill\/(\d+)/);
    const port = portMatch ? parseInt(portMatch[1], 10) : NaN;
    if (isNaN(port)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: `Invalid port: ${url.pathname}` }));
      return;
    }
    const result = killByPort(port);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // API: Launch a quick launch command
  if (url.pathname.startsWith('/api/launch/') && req.method === 'POST') {
    const indexMatch = url.pathname.match(/\/api\/launch\/(\d+)/);
    const index = indexMatch ? parseInt(indexMatch[1], 10) : NaN;
    if (isNaN(index)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Invalid command index' }));
      return;
    }
    const result = launchCommand(index);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // API: Get quick launch commands
  if (url.pathname === '/api/commands' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(quickLaunch));
    return;
  }

  // API: Create tunnel for a specific port
  if (url.pathname.startsWith('/api/tunnel/') && req.method === 'POST') {
    const portMatch = url.pathname.match(/\/api\/tunnel\/(\d+)/);
    const port = portMatch ? parseInt(portMatch[1], 10) : NaN;
    if (isNaN(port)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Invalid port' }));
      return;
    }
    const result = await createTunnel(port);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // API: Get active tunnels
  if (url.pathname === '/api/tunnels' && req.method === 'GET') {
    const tunnels = {};
    for (const [port, data] of activeTunnels) {
      tunnels[port] = data.url;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(tunnels));
    return;
  }

  // Proxy requests: /proxy/{port}/path - sets cookie and redirects to /p/path
  const proxyMatch = url.pathname.match(/^\/proxy\/(\d+)(\/.*)?$/);
  if (proxyMatch) {
    const targetPort = parseInt(proxyMatch[1], 10);
    const targetPath = proxyMatch[2] || '/';
    
    // Set cookie with the proxy port and redirect to /p/ path
    res.writeHead(302, {
      'Set-Cookie': `porthole_proxy_port=${targetPort}; Path=/; SameSite=Lax`,
      'Location': `/p${targetPath}${url.search}`,
    });
    res.end();
    return;
  }

  // Handle /p/ paths - use cookie to determine target port
  if (url.pathname.startsWith('/p/') || url.pathname === '/p') {
    // Parse cookie to get proxy port
    const cookies = req.headers.cookie || '';
    const portMatch = cookies.match(/porthole_proxy_port=(\d+)/);
    const targetPort = portMatch ? parseInt(portMatch[1], 10) : null;
    
    if (!targetPort) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<h1>No proxy target set</h1><p>Go back to <a href="/">Hoster</a> and click a Proxy link.</p>');
      return;
    }

    const targetPath = url.pathname.slice(2) || '/'; // Remove '/p' prefix
    
    const proxyReq = http.request({
      hostname: '127.0.0.1',
      port: targetPort,
      path: targetPath + url.search,
      method: req.method,
      headers: {
        ...req.headers,
        host: `localhost:${targetPort}`,
      },
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Proxy error: ${err.message}` }));
    });

    req.pipe(proxyReq);
    return;
  }

  // Handle bare paths when proxy cookie is set (for assets like /favicon.ico)
  if (!url.pathname.startsWith('/api/') && url.pathname !== '/') {
    const cookies = req.headers.cookie || '';
    const portMatch = cookies.match(/porthole_proxy_port=(\d+)/);
    const targetPort = portMatch ? parseInt(portMatch[1], 10) : null;
    
    if (targetPort) {
      const proxyReq = http.request({
        hostname: '127.0.0.1',
        port: targetPort,
        path: url.pathname + url.search,
        method: req.method,
        headers: {
          ...req.headers,
          host: `localhost:${targetPort}`,
        },
      }, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      });

      proxyReq.on('error', (err) => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Proxy error: ${err.message}` }));
      });

      req.pipe(proxyReq);
      return;
    }
  }

  // Serve HTML page
  if (url.pathname === '/' && req.method === 'GET') {
    const tunnelUrl = `https://${ngrokConfig.domain}`;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(getHtmlPage(tunnelUrl));
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// Check if ngrok is already running with the correct tunnel
async function checkExistingNgrok() {
  return new Promise((resolve) => {
    // ngrok exposes a local API on port 4040
    const req = http.get('http://127.0.0.1:4040/api/tunnels', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const tunnels = JSON.parse(data);
          // Check if there's a tunnel pointing to our port with our domain
          const existingTunnel = tunnels.tunnels?.find(t => 
            t.config?.addr?.includes(`:${serverPort}`) && 
            t.public_url?.includes(ngrokConfig.domain)
          );
          if (existingTunnel) {
            resolve({ exists: true, url: existingTunnel.public_url });
          } else {
            resolve({ exists: false, hasOtherTunnels: tunnels.tunnels?.length > 0 });
          }
        } catch (e) {
          resolve({ exists: false });
        }
      });
    });
    
    req.on('error', () => {
      // ngrok API not reachable, so ngrok isn't running
      resolve({ exists: false });
    });
    
    req.setTimeout(1000, () => {
      req.destroy();
      resolve({ exists: false });
    });
  });
}

// Kill any existing ngrok processes
function killExistingNgrok() {
  try {
    execSync('pkill -f ngrok', { timeout: 5000 });
    console.log('Killed existing ngrok process');
    // Give it a moment to fully terminate
    return new Promise(resolve => setTimeout(resolve, 500));
  } catch (e) {
    // No existing ngrok process, that's fine
    return Promise.resolve();
  }
}

// Start ngrok
function startNgrok() {
  return new Promise((resolve, reject) => {
    console.log(`Starting ngrok tunnel to ${ngrokConfig.domain}...`);

    // Write traffic policy to a temp file
    const policyPath = path.join(__dirname, '.ngrok-policy.json');
    fs.writeFileSync(policyPath, JSON.stringify(buildTrafficPolicy(), null, 2));

    const ngrokProcess = spawn('ngrok', [
      'http',
      `--domain=${ngrokConfig.domain}`,
      `--traffic-policy-file=${policyPath}`,
      serverPort.toString(),
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let startupTimeout = setTimeout(() => {
      // If we get here without error, ngrok is probably running
      resolve(ngrokProcess);
    }, 3000);

    ngrokProcess.on('error', (err) => {
      clearTimeout(startupTimeout);
      if (err.code === 'ENOENT') {
        reject(new Error('ngrok not found. Install from https://ngrok.com/download'));
      } else {
        reject(new Error(`Failed to start ngrok: ${err.message}`));
      }
    });

    ngrokProcess.stderr.on('data', (data) => {
      const output = data.toString();
      // Check for common error patterns
      if (output.includes('ERR_NGROK') || output.includes('authentication failed') || output.includes('error')) {
        clearTimeout(startupTimeout);
        reject(new Error(`ngrok error: ${output.trim()}`));
      }
    });

    ngrokProcess.on('close', (code) => {
      if (code !== 0 && code !== null) {
        clearTimeout(startupTimeout);
        reject(new Error(`ngrok exited with code ${code}`));
      }
    });
  });
}

// Main startup
async function main() {
  try {
    // Start the HTTP server first
    server.listen(serverPort, () => {
      console.log(`Hoster server running at http://localhost:${serverPort}`);
    });

    // Check if ngrok is already running with correct config
    const existing = await checkExistingNgrok();
    let ngrokProcess = null;
    
    if (existing.exists) {
      console.log(`Reusing existing ngrok tunnel at ${existing.url}`);
    } else {
      // Kill any existing ngrok that's not configured correctly
      if (existing.hasOtherTunnels) {
        console.log('Found ngrok with different config, restarting...');
        await killExistingNgrok();
      }
      ngrokProcess = await startNgrok();
      console.log(`Tunnel active at https://${ngrokConfig.domain}`);
    }

    // Handle graceful shutdown
    const shutdown = () => {
      console.log('\nShutting down...');
      if (ngrokProcess) {
        ngrokProcess.kill();
      }
      server.close();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
