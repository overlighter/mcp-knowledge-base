import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import dotenv from 'dotenv';

import express,{Request,Response, NextFunction} from 'express';
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RagieService } from './ragieService.js';
import { AirtableService } from './airtableService.js';
import { ApiKeyService2 } from './apikeyService2.js';
import crypto from 'crypto';
import fs from "fs";
import path from "path";
import { SIDE_LETTER_SYSTEM_PROMPT } from "./prompts.js";

const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
const apiKeyService = new ApiKeyService2();

// =============================================================================
// URL-BASED AUTHENTICATION (NO OAUTH)
// =============================================================================

function getBaseUrl(): string {
  if (process.env.RENDER_EXTERNAL_URL) {
    return process.env.RENDER_EXTERNAL_URL;
  }
  
  if (process.env.NGROK_URL) {
    return process.env.NGROK_URL;
  }
  
  const port = process.env.PORT || 3000;
  return `http://localhost:${port}`;
}

const projectRoot = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(projectRoot, '.env') });
const ragieService = new RagieService("tnt_JdgN2vTLRVd_uyxjbRI6iWJYttXGYX9vOsWdSDgOuWloz3MtgcNbvOJ")
const airtableService = new AirtableService();

const server = new McpServer({
  name: 'side-letter-knowledge-base',
  version: '1.0.0',
  capabilities: {
    resources: { subscribe: true, listChanged: true },
    tools: {},
    prompts: {}
  },
});

// ========================================================================
// ALL YOUR EXISTING MCP TOOLS (search, sync_airtable, browse_airtable_data, etc.)
// These remain EXACTLY THE SAME
// ========================================================================

server.tool(
  'search',
  `Search the knowledge base using natural language queries. Returns relevant chunks with citations. ${SIDE_LETTER_SYSTEM_PROMPT}`,
  {
    query: z.string().describe('The search query in natural language'),
    top_k: z.number().optional().default(10).describe('Number of results to return (default: 10)'),
    rerank: z.boolean().optional().default(true).describe('Use reranking for better results (default: true)'),
    filter_by_title: z.string().optional().describe('Optional: Filter by document title'),
    filter_by_type: z.string().optional().describe('Optional: Filter by document type (e.g., PDF, TXT)'),
    filter_by_source: z.string().optional().describe('Optional: Filter by source (e.g., Airtable)'),
    filter_by_table: z.string().optional().describe('Optional: Filter by Airtable table name'),
    filter_by_export_type: z.string().optional().describe('Optional: Filter by export type')
  },
  async ({ query, top_k, rerank, filter_by_title, filter_by_type, filter_by_source, filter_by_table, filter_by_export_type }) => {
    try {
      let filter = null;
      if (filter_by_title || filter_by_type || filter_by_source || filter_by_table || filter_by_export_type) {
        filter = {};
        if (filter_by_title) (filter as any).title = { $eq: filter_by_title };
        if (filter_by_type) (filter as any).document_type = { $eq: filter_by_type };
        if (filter_by_source) (filter as any).source = { $eq: filter_by_source };
        if (filter_by_table) (filter as any).table_name = { $eq: filter_by_table };
        if (filter_by_export_type) (filter as any).export_type = { $eq: filter_by_export_type };
      }

      const searchResponse = await ragieService.search(query, top_k, filter, rerank);
      
      const formattedResults = searchResponse.results
        .map((r: any, i: number) => {
          let citation = `[${i + 1}] ${r.citation.source}`;
          
          if (r.citation.page) citation += ` (Page ${r.citation.page})`;
          if (r.citation.tableName) citation += ` [${r.citation.tableName}]`;
          
          const docType = r.citation.documentType ? ` [${r.citation.documentType}]` : '';
          citation += docType;
          
          let metadataInfo = '';
          if (r.citation.dataSource === 'Airtable' && r.citation.recordCount) {
            metadataInfo = `\nAirtable Data: ${r.citation.recordCount} records`;
            if (r.citation.lastUpdated) {
              const updateDate = new Date(r.citation.lastUpdated).toLocaleDateString();
              metadataInfo += `, last updated: ${updateDate}`;
            }
          }
          
          return `${citation}${metadataInfo}\n${r.content}\nRelevance Score: ${r.score.toFixed(3)}\n`;
        })
        .join('\n---\n\n');

      const resultText = `Found ${searchResponse.totalResults} results for: "${query}"\n${rerank ? '(Results reranked for relevance)' : ''}\n\n${formattedResults}`;

      return {
        content: [{ type: 'text', text: resultText }],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Error searching knowledge base: ${errorMessage}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'sync_airtable',
  'Sync Airtable data to local files and Ragie knowledge base.',
  {},
  async () => {
    try {
      await airtableService.syncTables();
      return {
        content: [{ type: 'text', text: 'Successfully synced Airtable data.' }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error syncing Airtable: ${error}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'browse_airtable_data',
  'Browse and search specifically within Airtable data',
  {
    query: z.string().describe('Search query'),
    table: z.enum(['funds', 'allocators', 'both']).optional().default('both'),
    top_k: z.number().optional().default(10)
  },
  async ({ query, table, top_k }) => {
    try {
      let filter = { source: { $eq: 'Airtable' } };
      
      if (table !== 'both') {
        const tableName = table === 'funds' ? 'Funds [Master]' : 'Allocators [Master]';
        (filter as any).table_name = { $eq: tableName };
      }

      const searchResponse = await ragieService.search(query, top_k, filter, true);
      
      const formattedResults = searchResponse.results
        .map((r: any, i: number) => {
          let citation = `[${i + 1}] ${r.citation.tableName || 'Airtable Data'}`;
          if (r.citation.recordCount) citation += ` (${r.citation.recordCount} total records)`;
          
          let metadataInfo = '';
          if (r.citation.lastUpdated) {
            metadataInfo = `\nLast Updated: ${new Date(r.citation.lastUpdated).toLocaleDateString()}`;
          }
          
          return `${citation}${metadataInfo}\n${r.content}\nRelevance Score: ${r.score.toFixed(3)}\n`;
        })
        .join('\n---\n\n');

      const tableInfo = table === 'both' ? 'both tables' : `${table} table`;
      return {
        content: [{ type: 'text', text: `Found ${searchResponse.totalResults} results in ${tableInfo} for: "${query}"\n\n${formattedResults}` }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error browsing Airtable: ${error}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'test_airtable_connections',
  'Test connections to Airtable and Ragie APIs',
  {},
  async () => {
    try {
      await airtableService.testConnections();
      return {
        content: [{ type: 'text', text: 'Connection tests completed successfully.' }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Connection test failed: ${error}` }],
        isError: true,
      };
    }
  }
);

// ========================================================================
// ADMIN TOOLS (Modified for URL auth)
// ========================================================================

server.tool(
  'admin_list_tokens',
  'List all user tokens with emails. Requires admin token in URL.',
  {
    admin_token: z.string().describe('Your admin token for authentication')
  },
  async ({ admin_token }) => {
    try {
      if (!apiKeyService.isAdminKey(admin_token)) {
        return {
          content: [{ type: 'text', text: '❌ Access denied. Invalid admin token.' }],
          isError: true,
        };
      }

      const result = apiKeyService.listAllTokens();
      const stats = apiKeyService.getStats();
      
      const tokenList = result.userTokens.map((token, i) => {
        return `${i + 1}. Token: ${token.token.substring(0, 20)}...
   Email: ${token.email}
   Created: ${new Date(token.createdAt).toLocaleString()}
   Last Used: ${token.lastUsed ? new Date(token.lastUsed).toLocaleString() : 'Never'}
   Active: ${token.isActive ? '✅' : '❌'}`;
      }).join('\n\n');

      const summary = `📊 Token Statistics:
- Total User Tokens: ${stats.userCount}
- Active: ${stats.activeUserCount}
- Admin Keys: ${stats.adminCount}
- Last Updated: ${new Date(stats.lastUpdated).toLocaleString()}

📝 User Tokens:
${tokenList || 'No user tokens found'}`;

      return {
        content: [{ type: 'text', text: summary }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error listing tokens: ${error}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'admin_create_token',
  'Create new user token with email. Returns access URL. Requires admin token.',
  {
    admin_token: z.string().describe('Your admin token'),
    email: z.string().describe('Email to bind to token'),
    user_type: z.enum(['user', 'admin']).optional().default('user')
  },
  async ({ admin_token, email, user_type }) => {
    try {
      if (!apiKeyService.isAdminKey(admin_token)) {
        return {
          content: [{ type: 'text', text: '❌ Access denied.' }],
          isError: true,
        };
      }

      const result = apiKeyService.createUserToken(email, user_type);
      
      if (result.success) {
        return {
          content: [{ type: 'text', text: `✅ Token created!\n\nAccess URL:\n${result.accessUrl}\n\n⚠️  Copy this URL and send it to the user.` }],
        };
      } else {
        return {
          content: [{ type: 'text', text: `❌ ${result.message}` }],
          isError: true,
        };
      }
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'admin_delete_token',
  'Delete a user token by email. Requires admin token.',
  {
    admin_token: z.string().describe('Your admin token'),
    email: z.string().describe('Email of token to delete')
  },
  async ({ admin_token, email }) => {
    try {
      if (!apiKeyService.isAdminKey(admin_token)) {
        return {
          content: [{ type: 'text', text: '❌ Access denied.' }],
          isError: true,
        };
      }

      const tokenInfo = apiKeyService.getTokenByEmail(email);
      if (!tokenInfo.success || !tokenInfo.token) {
        return {
          content: [{ type: 'text', text: `❌ No token found for: ${email}` }],
          isError: true,
        };
      }

      const result = apiKeyService.deleteToken(tokenInfo.token.token, email);
      
      return {
        content: [{ type: 'text', text: result.success ? `✅ ${result.message}` : `❌ ${result.message}` }],
        isError: !result.success,
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'admin_find_token_by_email',
  'Find token details by email. Requires admin token.',
  {
    admin_token: z.string().describe('Your admin token'),
    email: z.string().describe('Email to search for')
  },
  async ({ admin_token, email }) => {
    try {
      if (!apiKeyService.isAdminKey(admin_token)) {
        return {
          content: [{ type: 'text', text: '❌ Access denied.' }],
          isError: true,
        };
      }

      const result = apiKeyService.getTokenByEmail(email);
      
      if (!result.success || !result.token) {
        return {
          content: [{ type: 'text', text: `❌ No token found for: ${email}` }],
        };
      }

      const accessUrl = apiKeyService.generateAccessUrl(email);

      return {
        content: [{ type: 'text', text: `✅ Token found for ${email}:

Token: ${result.token.token.substring(0, 20)}...
Full Token: ${result.token.token}
Created: ${new Date(result.token.createdAt).toLocaleString()}
Last Used: ${result.token.lastUsed ? new Date(result.token.lastUsed).toLocaleString() : 'Never'}
Active: ${result.token.isActive ? 'Yes' : 'No'}

Access URL:
${accessUrl.accessUrl}` }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error}` }],
        isError: true,
      };
    }
  }
);

// ========================================================================
// ALL YOUR EXISTING RESOURCES
// (funds, allocators, fund-details, etc. - ALL REMAIN THE SAME)
// ========================================================================

server.resource(
  "funds",
  "funds://all",
  {
    description: "Get all funds data",
    title: "All Funds",
    mimeType: "application/json",
  },
  async uri => {
    try {
      const funds = await import("../airtable_funds.json", { with: { type: "json" } }).then(m => m.default);
      return {
        contents: [{ uri: uri.href, text: JSON.stringify(funds, null, 2), mimeType: "application/json" }],
      };
    } catch (error) {
      return {
        contents: [{ uri: uri.href, text: JSON.stringify({ error: `Failed: ${error}` }), mimeType: "application/json" }],
      };
    }
  }
);

// ... (Include all other resources from your original server.ts - they're all the same)

// ========================================================================
// WEB SERVER - URL-BASED AUTHENTICATION
// ========================================================================

async function main() {
  try {
    // Root endpoint - Health check
    app.get("/", (req: Request, res: Response) => {
      res.status(200).json({
        name: "Side Letter MCP Server V2 (URL Auth)",
        version: "2.0.0",
        authentication: "URL-based tokens",
        endpoints: {
          mcp: "/mcp"
        },
        warning: "⚠️  Using insecure URL-based authentication"
      });
    });

// ========================================================================
// ADMIN SESSION MANAGEMENT
// ========================================================================

interface AdminSession {
  adminKey: string;
  createdAt: number;
  expiresAt: number;
}

const adminSessions = new Map<string, AdminSession>();

setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of adminSessions.entries()) {
    if (now > session.expiresAt) adminSessions.delete(sessionId);
  }
}, 5 * 60 * 1000);

function requireAdminSession(req: Request, res: Response, next: NextFunction) {
  const sessionId = req.headers['x-session-id'] as string;
  
  if (!sessionId) {
    return res.status(401).json({ success: false, message: 'No session' });
  }
  
  const session = adminSessions.get(sessionId);
  
  if (!session || Date.now() > session.expiresAt) {
    if (session) adminSessions.delete(sessionId);
    return res.status(401).json({ success: false, message: 'Session expired' });
  }
  
  session.expiresAt = Date.now() + (60 * 60 * 1000);
  next();
}

app.post("/admin/login", (req: Request, res: Response) => {
  const { admin_key } = req.body;
  
  if (!apiKeyService.isAdminKey(admin_key)) {
    return res.status(403).json({ success: false, message: 'Invalid admin key' });
  }
  
  const sessionId = 'admin_session_' + crypto.randomBytes(32).toString('hex');
  const expiresIn = 60 * 60 * 1000;
  
  adminSessions.set(sessionId, {
    adminKey: admin_key,
    createdAt: Date.now(),
    expiresAt: Date.now() + expiresIn
  });
  
  console.log('✓ Admin logged in');
  res.json({ success: true, sessionId, expiresIn });
});

app.post("/admin/logout", (req: Request, res: Response) => {
  const sessionId = req.headers['x-session-id'] as string;
  if (sessionId && adminSessions.has(sessionId)) {
    adminSessions.delete(sessionId);
    console.log('✓ Admin logged out');
  }
  res.json({ success: true });
});

app.get("/admin/api/tokens", requireAdminSession, (req: Request, res: Response) => {
  const result = apiKeyService.listAllTokens();
  const stats = apiKeyService.getStats();
  res.json({ success: true, tokens: result.userTokens, stats });
});

app.post("/admin/api/tokens", requireAdminSession, (req: Request, res: Response) => {
  const { email } = req.body;
  const result = apiKeyService.createUserToken(email, 'user');
  res.json(result);
});

app.delete("/admin/api/tokens/:email", requireAdminSession, (req: Request, res: Response) => {
  const email = req.params.email;
  const tokenInfo = apiKeyService.getTokenByEmail(email);
  
  if (!tokenInfo.success || !tokenInfo.token) {
    return res.json({ success: false, message: 'Token not found' });
  }
  
  const result = apiKeyService.deleteToken(tokenInfo.token.token, email);
  res.json(result);
});

// Admin dashboard (modified for URL auth)
app.get("/admin", (req: Request, res: Response) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin Dashboard V2 - URL Token Management</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #f5f7fa;
            min-height: 100vh;
        }
        .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 30px;
            border-radius: 12px;
            margin-bottom: 30px;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
        }
        .warning-banner {
            background: #fff3cd;
            border: 2px solid #ffc107;
            color: #856404;
            padding: 15px;
            border-radius: 8px;
            margin-bottom: 20px;
            font-weight: 600;
        }
        .login-card {
            background: white;
            padding: 40px;
            border-radius: 12px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            max-width: 400px;
            margin: 100px auto;
        }
        .card {
            background: white;
            padding: 30px;
            border-radius: 12px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            margin-bottom: 20px;
        }
        .card h2 {
            margin-bottom: 20px;
            color: #333;
        }
        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-bottom: 30px;
        }
        .stat-box {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 20px;
            border-radius: 8px;
            text-align: center;
        }
        .stat-box .number { font-size: 32px; font-weight: bold; margin-bottom: 5px; }
        .stat-box .label { opacity: 0.9; font-size: 14px; }
        table {
            width: 100%;
            border-collapse: collapse;
        }
        th, td {
            padding: 12px;
            text-align: left;
            border-bottom: 1px solid #e0e0e0;
        }
        th {
            background: #f8f9fa;
            font-weight: 600;
            color: #495057;
        }
        tr:hover { background: #f8f9fa; }
        .token-key {
            font-family: monospace;
            background: #f8f9fa;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 13px;
        }
        .badge {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: 600;
        }
        .badge-success { background: #d4edda; color: #155724; }
        input, button {
            width: 100%;
            padding: 12px;
            border: 2px solid #e0e0e0;
            border-radius: 8px;
            font-size: 14px;
            margin-bottom: 15px;
        }
        input:focus {
            outline: none;
            border-color: #667eea;
        }
        button {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            cursor: pointer;
            font-weight: 600;
        }
        .btn-danger {
            background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
            padding: 8px 16px;
            border-radius: 6px;
            border: none;
            color: white;
            cursor: pointer;
            font-size: 12px;
            font-weight: 600;
            width: auto;
        }
        .btn-copy {
            background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%);
            padding: 6px 12px;
            margin-left: 10px;
            width: auto;
        }
        .error { color: #dc3545; padding: 10px; background: #f8d7da; border-radius: 6px; margin-bottom: 15px; }
        .success { color: #155724; padding: 10px; background: #d4edda; border-radius: 6px; margin-bottom: 15px; }
        .hidden { display: none; }
        .logout-btn {
            background: rgba(255,255,255,0.2);
            border: 2px solid rgba(255,255,255,0.5);
            padding: 8px 20px;
            width: auto;
            margin: 0;
        }
        .url-box {
            background: #e7f3ff;
            padding: 15px;
            border-radius: 8px;
            margin-top: 10px;
            font-family: monospace;
            font-size: 12px;
            word-break: break-all;
            border: 2px solid #2196F3;
        }
    </style>
</head>
<body>
    <div id="loginPage" class="hidden">
        <div class="login-card">
            <h1 style="text-align: center; margin-bottom: 10px; color: #333;">🔐 Admin Login V2</h1>
            <p style="text-align: center; color: #666; margin-bottom: 30px;">URL Token Management</p>
            <div id="loginError" class="error hidden"></div>
            <form id="loginForm">
                <input type="password" id="adminKey" placeholder="Enter Admin Token" required>
                <button type="submit">Login</button>
            </form>
        </div>
    </div>

    <div id="dashboardPage" class="hidden">
        <div class="container">
            <div class="header">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <h1>🔑 URL Token Management V2</h1>
                        <p>⚠️  Using insecure URL-based authentication</p>
                    </div>
                    <button class="logout-btn" onclick="logout()">Logout</button>
                </div>
            </div>

            <div class="warning-banner">
                ⚠️  WARNING: Tokens are sent in URLs and logged everywhere! For demonstration only.
            </div>

            <div class="stats" id="stats"></div>

            <div class="card">
                <h2>➕ Create New User Token</h2>
                <div id="addMessage" class="hidden"></div>
                <form id="addTokenForm">
                    <input type="email" id="newEmail" placeholder="User's Email Address" required>
                    <button type="submit">Generate Token & URL</button>
                </form>
            </div>

            <div class="card">
                <h2>📋 Active User Tokens</h2>
                <div id="tokensTable"></div>
            </div>
        </div>
    </div>

    <script>
        let sessionId = localStorage.getItem('admin_session_v2');
        
        if (sessionId) {
            loadDashboard();
        } else {
            showLogin();
        }

        function showLogin() {
            document.getElementById('loginPage').classList.remove('hidden');
            document.getElementById('dashboardPage').classList.add('hidden');
        }

        function showDashboard() {
            document.getElementById('loginPage').classList.add('hidden');
            document.getElementById('dashboardPage').classList.remove('hidden');
        }

        document.getElementById('loginForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const adminKey = document.getElementById('adminKey').value;
            const errorDiv = document.getElementById('loginError');
            
            try {
                const response = await fetch('/admin/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ admin_key: adminKey })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    sessionId = data.sessionId;
                    localStorage.setItem('admin_session_v2', sessionId);
                    loadDashboard();
                } else {
                    errorDiv.textContent = data.message || 'Invalid admin token';
                    errorDiv.classList.remove('hidden');
                }
            } catch (error) {
                errorDiv.textContent = 'Login failed: ' + error.message;
                errorDiv.classList.remove('hidden');
            }
        });

        async function loadDashboard() {
            try {
                const response = await fetch('/admin/api/tokens', {
                    headers: { 'X-Session-Id': sessionId }
                });
                
                if (response.status === 401) {
                    logout();
                    return;
                }
                
                const data = await response.json();
                
                if (data.success) {
                    showDashboard();
                    renderStats(data.stats);
                    renderTokens(data.tokens);
                }
            } catch (error) {
                console.error('Failed to load dashboard:', error);
                logout();
            }
        }

        function renderStats(stats) {
            const statsHtml = \`
                <div class="stat-box">
                    <div class="number">\${stats.userCount}</div>
                    <div class="label">Total Tokens</div>
                </div>
                <div class="stat-box">
                    <div class="number">\${stats.activeUserCount}</div>
                    <div class="label">Active</div>
                </div>
                <div class="stat-box">
                    <div class="number">\${stats.adminCount}</div>
                    <div class="label">Admin Keys</div>
                </div>
            \`;
            document.getElementById('stats').innerHTML = statsHtml;
        }

        function renderTokens(tokens) {
            const tableDiv = document.getElementById('tokensTable');
            
            if (tokens.length === 0) {
                tableDiv.innerHTML = '<div style="text-align:center;padding:40px;color:#666;">No tokens yet. Create one above!</div>';
                return;
            }
            
            const tableHtml = \`
                <table>
                    <thead>
                        <tr>
                            <th>Email</th>
                            <th>Created</th>
                            <th>Last Used</th>
                            <th style="min-width: 400px;">Access URL</th>
                            <th>Action</th>
                        </tr>
                    </thead>
                    <tbody>
                        \${tokens.filter(t => t.isActive).map(token => {
                            const baseUrl = window.location.origin;
                            const accessUrl = \`\${baseUrl}/?token=\${token.token}&email=\${encodeURIComponent(token.email)}\`;
                            return \`
                            <tr>
                                <td><span class="badge badge-success">\${token.email}</span></td>
                                <td>\${new Date(token.createdAt).toLocaleDateString()}</td>
                                <td>\${token.lastUsed ? new Date(token.lastUsed).toLocaleDateString() : 'Never'}</td>
                                <td>
                                    <div style="display: flex; align-items: center; gap: 10px;">
                                        <input type="text" readonly value="\${accessUrl}" 
                                               style="flex: 1; font-family: monospace; font-size: 11px; padding: 6px; 
                                                      background: #f8f9fa; border: 1px solid #dee2e6; border-radius: 4px;"
                                               onclick="this.select()">
                                        <button class="btn-copy" onclick="copyUrl('\${accessUrl}')" 
                                                style="white-space: nowrap;">
                                            📋 Copy
                                        </button>
                                    </div>
                                </td>
                                <td>
                                    <button class="btn-danger" onclick="deleteToken('\${token.email}')">Delete</button>
                                </td>
                            </tr>
                        \`;
                        }).join('')}
                    </tbody>
                </table>
            \`;
            tableDiv.innerHTML = tableHtml;
        }

        document.getElementById('addTokenForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const messageDiv = document.getElementById('addMessage');
            const email = document.getElementById('newEmail').value;
            
            try {
                const response = await fetch('/admin/api/tokens', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Session-Id': sessionId
                    },
                    body: JSON.stringify({ email })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    messageDiv.className = 'success';
                    messageDiv.innerHTML = \`✅ Token created successfully!
                        <div style="margin-top: 15px;">
                            <strong>Access URL:</strong>
                            <div style="display: flex; gap: 10px; margin-top: 8px;">
                                <input type="text" readonly value="\${data.accessUrl}" 
                                       style="flex: 1; font-family: monospace; font-size: 12px; padding: 10px; 
                                              background: #f8f9fa; border: 1px solid #2196F3; border-radius: 4px;"
                                       onclick="this.select()">
                                <button onclick="copyUrlFromInput(this.previousElementSibling.value)" 
                                        style="background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%);
                                               color: white; border: none; padding: 10px 20px; border-radius: 4px;
                                               cursor: pointer; font-weight: 600; white-space: nowrap;">
                                    📋 Copy URL
                                </button>
                            </div>
                            <small style="color: #666; display: block; margin-top: 8px;">
                                Send this URL to the user. They can click it or add it to their MCP client config.
                            </small>
                        </div>\`;
                    document.getElementById('addTokenForm').reset();
                    setTimeout(() => loadDashboard(), 2000);
                } else {
                    messageDiv.className = 'error';
                    messageDiv.textContent = '❌ ' + data.message;
                }
                messageDiv.classList.remove('hidden');
            } catch (error) {
                messageDiv.className = 'error';
                messageDiv.textContent = 'Failed: ' + error.message;
                messageDiv.classList.remove('hidden');
            }
        });

        function copyUrl(url) {
            navigator.clipboard.writeText(url);
            alert('✅ URL copied to clipboard!');
        }

        function copyUrlFromInput(url) {
            navigator.clipboard.writeText(url);
            alert('✅ URL copied to clipboard!\\n\\nYou can now send this to the user.');
        }

        async function deleteToken(email) {
            if (!confirm(\`Delete token for \${email}?\`)) return;
            
            try {
                const response = await fetch(\`/admin/api/tokens/\${encodeURIComponent(email)}\`, {
                    method: 'DELETE',
                    headers: { 'X-Session-Id': sessionId }
                });
                
                const data = await response.json();
                if (data.success) {
                    loadDashboard();
                } else {
                    alert('Failed: ' + data.message);
                }
            } catch (error) {
                alert('Failed: ' + error.message);
            }
        }

        function logout() {
            sessionId = null;
            localStorage.removeItem('admin_session_v2');
            showLogin();
            document.getElementById('loginForm').reset();
        }

        setInterval(() => {
            if (sessionId && !document.getElementById('dashboardPage').classList.contains('hidden')) {
                loadDashboard();
            }
        }, 30000);
    </script>
</body>
</html>
  `);
});

    // MCP endpoint - Validates token/email from URL query params
    app.post("/mcp", async (req: Request, res: Response) => {
      const { token, email } = req.query;

      if (!token || !email) {
        return res.status(401).json({ error: 'Authentication required: token and email must be in URL' });
      }

      const validation = apiKeyService.validateTokenAndEmail(token as string, email as string);

      if (!validation.isValid) {
        return res.status(403).json({ error: 'Invalid token or email combination' });
      }

      console.log('✓ URL token validated:', email);

      const httpserver = server;
      const httpTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        httpTransport.close();
        httpserver.close();
      });
      await httpserver.connect(httpTransport);
      await httpTransport.handleRequest(req, res, req.body);
    });

    const PORT = parseInt(process.env.PORT || '3000', 10);
    app.listen(PORT, () => {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`⚠️  Side Letter MCP Server V2 (INSECURE URL AUTH)`);
      console.log(`${'='.repeat(60)}`);
      console.log(`Local: http://localhost:${PORT}`);
      console.log(`Public: ${getBaseUrl()}`);
      console.log(`\nEndpoints:`);
      console.log(`  - MCP: /mcp?token=TOKEN&email=EMAIL`);
      console.log(`  - Admin Dashboard: /admin`);
      console.log(`\n⚠️  WARNING: Tokens in URLs are insecure!`);
      console.log(`${'='.repeat(60)}\n`);
    });

  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});