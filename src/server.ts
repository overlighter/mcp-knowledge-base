import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import dotenv from 'dotenv';
import { SIDE_LETTER_SYSTEM_PROMPT } from './prompts.js';

import express, { Request, Response, NextFunction } from 'express';
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RagieService } from './ragieService.js';
import { AirtableService } from './airtableService.js';
import { ApiKeyService } from './apiKeyService.js';
import crypto from 'crypto';
import fs from "fs";
import path from "path";

const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
const apiKeyService = new ApiKeyService();

// =============================================================================
// OAUTH STORAGE AND HELPERS
// =============================================================================

// Add this near the top of your file, after imports
function getBaseUrl(): string {
  // Production: Use Render's external URL
  if (process.env.RENDER_EXTERNAL_URL) {
    return process.env.RENDER_EXTERNAL_URL;
  }

  // Development: Use ngrok if available
  if (process.env.NGROK_URL) {
    return process.env.NGROK_URL;
  }

  // Fallback: Local development
  const port = process.env.PORT || 3000;
  return `http://localhost:${port}`;
}
interface AuthCodeData {
  code_challenge: string;
  code_challenge_method: string;
  redirect_uri: string;
  client_id: string;
  api_key: string;
  created_at: number;
}

interface AccessTokenData {
  api_key: string;
  created_at: number;
  expires_at: number;
}

const authCodes = new Map<string, AuthCodeData>();
const accessTokens = new Map<string, AccessTokenData>();

setInterval(() => {
  const now = Date.now();
  const TEN_MINUTES = 10 * 60 * 1000;
  for (const [code, data] of authCodes.entries()) {
    if (now - data.created_at > TEN_MINUTES) authCodes.delete(code);
  }
  for (const [token, data] of accessTokens.entries()) {
    if (now > data.expires_at) accessTokens.delete(token);
  }
}, 60000);

function verifyCodeChallenge(codeVerifier: string, codeChallenge: string, method: string): boolean {
  if (method === 'S256') {
    const hash = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    return hash === codeChallenge;
  } else if (method === 'plain') {
    return codeVerifier === codeChallenge;
  }
  return false;
}

const projectRoot = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(projectRoot, '.env') });


if (!process.env.RAGIE_API_KEY) {
  throw new Error('RAGIE_API_KEY environment variable is required');
}

const ragieService = new RagieService(process.env.RAGIE_API_KEY);
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

server.tool(
  'search',
  `${SIDE_LETTER_SYSTEM_PROMPT}`,
  {
    query: z.string().describe('The search query in natural language'),
    top_k: z.number().optional().default(10).describe('Number of results to return (default: 10)'),
    rerank: z.boolean().optional().default(true).describe('Use reranking for better results (default: true)'),
    filter_by_title: z.string().optional().describe('Optional: Filter by document title'),
    filter_by_type: z.string().optional().describe('Optional: Filter by document type (e.g., PDF, TXT)'),
    filter_by_source: z.string().optional().describe('Optional: Filter by source (e.g., Airtable)'),
    filter_by_table: z.string().optional().describe('Optional: Filter by Airtable table name (e.g., "Funds [Master]", "Allocators [Master]")'),
    filter_by_export_type: z.string().optional().describe('Optional: Filter by export type (e.g., "Airtable Export")')
  },
  async ({ query, top_k, rerank, filter_by_title, filter_by_type, filter_by_source, filter_by_table, filter_by_export_type }) => {
    try {
      // Build filter object if any filters are provided
      let filter = null;
      if (filter_by_title || filter_by_type || filter_by_source || filter_by_table || filter_by_export_type) {
        filter = {};
        if (filter_by_title) {
          (filter as any).title = { $eq: filter_by_title };
        }
        if (filter_by_type) {
          (filter as any).document_type = { $eq: filter_by_type };
        }
        if (filter_by_source) {
          (filter as any).source = { $eq: filter_by_source };
        }
        if (filter_by_table) {
          (filter as any).table_name = { $eq: filter_by_table };
        }
        if (filter_by_export_type) {
          (filter as any).export_type = { $eq: filter_by_export_type };
        }
      }

      const searchResponse = await ragieService.search(query, top_k, filter, rerank);

      // Format results with citations
      const formattedResults = searchResponse.results
        .map((r: any, i: number) => {
          let citation = `[${i + 1}] ${r.citation.source}`;

          // Add page info if available
          if (r.citation.page) {
            citation += ` (Page ${r.citation.page})`;
          }

          // Add Airtable-specific info if available
          if (r.citation.tableName) {
            citation += ` [${r.citation.tableName}]`;
          }

          // Add document type
          const docType = r.citation.documentType ? ` [${r.citation.documentType}]` : '';
          citation += docType;

          // Add metadata info for Airtable exports
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
        content: [
          {
            type: 'text',
            text: resultText,
          },
        ],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      return {
        content: [
          {
            type: 'text',
            text: `Error searching knowledge base: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  }
);



server.tool(
  'sync_airtable',
  'Sync Airtable data to local files and Ragie knowledge base. Only updates if data has changed.',
  {},
  async () => {
    try {
      await airtableService.syncTables();

      return {
        content: [
          {
            type: 'text',
            text: 'Successfully synced Airtable data. Check console for details.',
          },
        ],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      return {
        content: [
          {
            type: 'text',
            text: `Error syncing Airtable data: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  'browse_airtable_data',
  `Browse and search specifically within Airtable data (Funds and Allocators) and also ${SIDE_LETTER_SYSTEM_PROMPT} `,
  {
    query: z.string().describe('Search query for Airtable data'),
    table: z.enum(['funds', 'allocators', 'both']).optional().default('both').describe('Which table to search: funds, allocators, or both'),
    top_k: z.number().optional().default(10).describe('Number of results to return (default: 10)')
  },
  async ({ query, table, top_k }) => {
    try {
      let filter = { source: { $eq: 'Airtable' } };

      // Add table-specific filter if not searching both
      if (table !== 'both') {
        const tableName = table === 'funds' ? 'Funds [Master]' : 'Allocators [Master]';
        (filter as any).table_name = { $eq: tableName };
      }

      const searchResponse = await ragieService.search(query, top_k, filter, true);

      // Format results with Airtable-specific information
      const formattedResults = searchResponse.results
        .map((r: any, i: number) => {
          let citation = `[${i + 1}] ${r.citation.tableName || 'Airtable Data'}`;

          if (r.citation.recordCount) {
            citation += ` (${r.citation.recordCount} total records)`;
          }

          let metadataInfo = '';
          if (r.citation.lastUpdated) {
            const updateDate = new Date(r.citation.lastUpdated).toLocaleDateString();
            metadataInfo = `\nLast Updated: ${updateDate}`;
          }

          return `${citation}${metadataInfo}\n${r.content}\nRelevance Score: ${r.score.toFixed(3)}\n`;
        })
        .join('\n---\n\n');

      const tableInfo = table === 'both' ? 'both Funds and Allocators tables' :
        table === 'funds' ? 'Funds [Master] table' : 'Allocators [Master] table';

      return {
        content: [
          {
            type: 'text',
            text: `Found ${searchResponse.totalResults} results in ${tableInfo} for: "${query}"\n\n${formattedResults}`,
          },
        ],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      return {
        content: [
          {
            type: 'text',
            text: `Error browsing Airtable data: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  'test_airtable_connections',
  'Test connections to both Airtable and Ragie APIs',
  {},
  async () => {
    try {
      await airtableService.testConnections();

      return {
        content: [
          {
            type: 'text',
            text: 'Connection tests completed successfully. Check console for details.',
          },
        ],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      return {
        content: [
          {
            type: 'text',
            text: `Connection test failed: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  }
);
server.tool(
  'admin_list_tokens',
  'List all user API tokens with their bound emails and usage info. Requires admin API key.',
  {
    admin_key: z.string().describe('Your admin API key for authentication')
  },
  async ({ admin_key }) => {
    try {
      if (!apiKeyService.isAdminKey(admin_key)) {
        return {
          content: [{
            type: 'text',
            text: '❌ Access denied. Invalid admin API key.',
          }],
          isError: true,
        };
      }

      const tokens = apiKeyService.listUserApiKeys();
      const stats = apiKeyService.getStats();

      const tokenList = tokens.map((token, i) => {
        return `${i + 1}. Key: ${token.key.substring(0, 20)}...
   Email: ${token.email || '❌ Not bound yet'}
   Created: ${new Date(token.createdAt).toLocaleString()}
   Last Used: ${token.lastUsed ? new Date(token.lastUsed).toLocaleString() : 'Never'}`;
      }).join('\n\n');

      const summary = `📊 API Key Statistics:
- Total User Keys: ${stats.userCount}
- Bound to Email: ${stats.boundKeys}
- Unbound: ${stats.unboundKeys}
- Admin Keys: ${stats.adminCount}
- Last Updated: ${new Date(stats.lastUpdated).toLocaleString()}

📝 User API Keys:
${tokenList || 'No user keys found'}`;

      return {
        content: [{
          type: 'text',
          text: summary,
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `Error listing tokens: ${error instanceof Error ? error.message : String(error)}`,
        }],
        isError: true,
      };
    }
  }
);

server.tool(
  'admin_add_token',
  'Add a new user API token. Optionally pre-bind to an email address. Requires admin API key.',
  {
    admin_key: z.string().describe('Your admin API key for authentication'),
    new_token: z.string().describe('The new API key to add'),
    email: z.string().optional().describe('Optional: Pre-bind this key to an email address')
  },
  async ({ admin_key, new_token, email }) => {
    try {
      if (!apiKeyService.isAdminKey(admin_key)) {
        return {
          content: [{
            type: 'text',
            text: '❌ Access denied. Invalid admin API key.',
          }],
          isError: true,
        };
      }

      const result = apiKeyService.addUserApiKey(new_token, email || null);

      return {
        content: [{
          type: 'text',
          text: result.success
            ? `✅ ${result.message}${email ? `\nBound to email: ${email}` : '\n⚠️  Key will be bound to email on first use'}`
            : `❌ ${result.message}`,
        }],
        isError: !result.success,
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `Error adding token: ${error instanceof Error ? error.message : String(error)}`,
        }],
        isError: true,
      };
    }
  }
);

server.tool(
  'admin_delete_token',
  'Delete a user API token by key. Can use full key or just first 20 characters. Requires admin API key.',
  {
    admin_key: z.string().describe('Your admin API key for authentication'),
    token_to_delete: z.string().describe('The API key to delete (full key or first 20 characters)')
  },
  async ({ admin_key, token_to_delete }) => {
    try {
      if (!apiKeyService.isAdminKey(admin_key)) {
        return {
          content: [{
            type: 'text',
            text: '❌ Access denied. Invalid admin API key.',
          }],
          isError: true,
        };
      }

      let fullKey = token_to_delete;
      if (token_to_delete.length < 30) {
        const tokens = apiKeyService.listUserApiKeys();
        const found = tokens.find(t => t.key.startsWith(token_to_delete));
        if (found) {
          fullKey = found.key;
        } else {
          return {
            content: [{
              type: 'text',
              text: `❌ No token found matching: ${token_to_delete}`,
            }],
            isError: true,
          };
        }
      }

      const result = apiKeyService.removeUserApiKey(fullKey);
      if (result.success) {
        if ((result as any).removedAccessToken) accessTokens.delete((result as any).removedAccessToken);
        if ((result as any).removedRefreshToken) accessTokens.delete((result as any).removedRefreshToken);
      }

      return {
        content: [{
          type: 'text',
          text: result.success ? `✅ ${result.message}` : `❌ ${result.message}`,
        }],
        isError: !result.success,
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `Error deleting token: ${error instanceof Error ? error.message : String(error)}`,
        }],
        isError: true,
      };
    }
  }
);

server.tool(
  'admin_find_token_by_email',
  'Find which API token is associated with a specific email address. Requires admin API key.',
  {
    admin_key: z.string().describe('Your admin API key for authentication'),
    email: z.string().describe('The email address to search for')
  },
  async ({ admin_key, email }) => {
    try {
      if (!apiKeyService.isAdminKey(admin_key)) {
        return {
          content: [{
            type: 'text',
            text: '❌ Access denied. Invalid admin API key.',
          }],
          isError: true,
        };
      }

      const tokens = apiKeyService.listUserApiKeys();
      const found = tokens.find(t => t.email?.toLowerCase() === email.toLowerCase());

      if (!found) {
        return {
          content: [{
            type: 'text',
            text: `❌ No token found for email: ${email}`,
          }],
        };
      }

      return {
        content: [{
          type: 'text',
          text: `✅ Token found for ${email}:
          
Key: ${found.key.substring(0, 20)}...
Full Key: ${found.key}
Created: ${new Date(found.createdAt).toLocaleString()}
Last Used: ${found.lastUsed ? new Date(found.lastUsed).toLocaleString() : 'Never'}`,
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `Error searching: ${error instanceof Error ? error.message : String(error)}`,
        }],
        isError: true,
      };
    }
  }
);
// Add resources for funds and allocators data
server.resource(
  "funds",
  "funds://all",
  {
    description: "Get all funds data from the local JSON database",
    title: "All Funds",
    mimeType: "application/json",
  },
  async uri => {
    try {
      const funds = await import("../airtable_funds.json", {
        with: { type: "json" },
      }).then(m => m.default);

      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(funds, null, 2),
            mimeType: "application/json",
          },
        ],
      };
    } catch (error) {
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify({ error: `Failed to load funds data: ${error}` }),
            mimeType: "application/json",
          },
        ],
      };
    }
  }
);

server.resource(
  "allocators",
  "allocators://all",
  {
    description: "Get all allocators data from the local JSON database",
    title: "All Allocators",
    mimeType: "application/json",
  },
  async uri => {
    try {
      const allocators = await import("../airtable_allocators.json", {
        with: { type: "json" },
      }).then(m => m.default);

      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(allocators, null, 2),
            mimeType: "application/json",
          },
        ],
      };
    } catch (error) {
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify({ error: `Failed to load allocators data: ${error}` }),
            mimeType: "application/json",
          },
        ],
      };
    }
  }
);

server.resource(
  "fund-details",
  new ResourceTemplate("funds://{fundId}/details", { list: undefined }),
  {
    description: "Get a specific fund's details from the database",
    title: "Fund Details",
    mimeType: "application/json",
  },
  async (uri, { fundId }) => {
    try {
      const funds = await import("../airtable_funds.json", {
        with: { type: "json" },
      }).then(m => m.default);

      const fund = funds.find(f => f.id === fundId as string);

      if (fund == null) {
        return {
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify({ error: "Fund not found" }),
              mimeType: "application/json",
            },
          ],
        };
      }

      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(fund, null, 2),
            mimeType: "application/json",
          },
        ],
      };
    } catch (error) {
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify({ error: `Failed to load fund data: ${error}` }),
            mimeType: "application/json",
          },
        ],
      };
    }
  }
);

server.resource(
  "allocator-details",
  new ResourceTemplate("allocators://{allocatorId}/details", { list: undefined }),
  {
    description: "Get a specific allocator's details from the database",
    title: "Allocator Details",
    mimeType: "application/json",
  },
  async (uri, { allocatorId }) => {
    try {
      const allocators = await import("../airtable_allocators.json", {
        with: { type: "json" },
      }).then(m => m.default);

      const allocator = allocators.find(a => a.id === allocatorId as string);

      if (allocator == null) {
        return {
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify({ error: "Allocator not found" }),
              mimeType: "application/json",
            },
          ],
        };
      }

      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(allocator, null, 2),
            mimeType: "application/json",
          },
        ],
      };
    } catch (error) {
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify({ error: `Failed to load allocator data: ${error}` }),
            mimeType: "application/json",
          },
        ],
      };
    }
  }
);

server.resource(
  "funds-by-status",
  new ResourceTemplate("funds://status/{status}", { list: undefined }),
  {
    description: "Get funds filtered by fundraising status",
    title: "Funds by Status",
    mimeType: "application/json",
  },
  async (uri, { status }) => {
    try {
      const funds = await import("../airtable_funds.json", {
        with: { type: "json" },
      }).then(m => m.default);

      const filteredFunds = funds.filter(fund =>
        fund.fields["Fundraising Status"]?.toLowerCase() === (status as string).toLowerCase()
      );

      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify({
              status: status,
              count: filteredFunds.length,
              funds: filteredFunds
            }, null, 2),
            mimeType: "application/json",
          },
        ],
      };
    } catch (error) {
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify({ error: `Failed to filter funds by status: ${error}` }),
            mimeType: "application/json",
          },
        ],
      };
    }
  }
);

server.resource(
  "allocators-by-type",
  new ResourceTemplate("allocators://type/{type}", { list: undefined }),
  {
    description: "Get allocators filtered by investor type",
    title: "Allocators by Type",
    mimeType: "application/json",
  },
  async (uri, { type }) => {
    try {
      const allocators = await import("../airtable_allocators.json", {
        with: { type: "json" },
      }).then(m => m.default);

      const filteredAllocators = allocators.filter(allocator =>
        allocator.fields["Investor Type"]?.toLowerCase().includes((type as string).toLowerCase())
      );

      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify({
              type: type,
              count: filteredAllocators.length,
              allocators: filteredAllocators
            }, null, 2),
            mimeType: "application/json",
          },
        ],
      };
    } catch (error) {
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify({ error: `Failed to filter allocators by type: ${error}` }),
            mimeType: "application/json",
          },
        ],
      };
    }
  }
);

server.resource(
  "funds-by-name",
  new ResourceTemplate("funds://name/{fundName}", { list: undefined }),
  {
    description: "Search funds by fund name (partial match, case-insensitive)",
    title: "Funds by Name",
    mimeType: "application/json",
  },
  async (uri, { fundName }) => {
    try {
      const funds = await import("../airtable_funds.json", {
        with: { type: "json" },
      }).then(m => m.default);

      const searchTerm = (fundName as string).toLowerCase();
      const matchingFunds = funds.filter(fund => {
        const name = fund.fields["Fund Name"]?.toLowerCase() || '';
        return name.includes(searchTerm);
      });

      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify({
              searchTerm: fundName,
              count: matchingFunds.length,
              funds: matchingFunds
            }, null, 2),
            mimeType: "application/json",
          },
        ],
      };
    } catch (error) {
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify({ error: `Failed to search funds by name: ${error}` }),
            mimeType: "application/json",
          },
        ],
      };
    }
  }
);

server.resource(
  "allocators-by-name",
  new ResourceTemplate("allocators://name/{investorName}", { list: undefined }),
  {
    description: "Search allocators by investor name (partial match, case-insensitive)",
    title: "Allocators by Investor Name",
    mimeType: "application/json",
  },
  async (uri, { investorName }) => {
    try {
      const allocators = await import("../airtable_allocators.json", {
        with: { type: "json" },
      }).then(m => m.default);

      const searchTerm = (investorName as string).toLowerCase();
      const matchingAllocators = allocators.filter(allocator => {
        const name = allocator.fields["Investor Name"]?.toLowerCase() || '';
        return name.includes(searchTerm);
      });

      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify({
              searchTerm: investorName,
              count: matchingAllocators.length,
              allocators: matchingAllocators
            }, null, 2),
            mimeType: "application/json",
          },
        ],
      };
    } catch (error) {
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify({ error: `Failed to search allocators by name: ${error}` }),
            mimeType: "application/json",
          },
        ],
      };
    }
  }
);

server.resource(
  "allocators-by-country",
  new ResourceTemplate("allocators://country/{country}", { list: undefined }),
  {
    description: "Get allocators filtered by country (partial match, case-insensitive)",
    title: "Allocators by Country",
    mimeType: "application/json",
  },
  async (uri, { country }) => {
    try {
      const allocators = await import("../airtable_allocators.json", {
        with: { type: "json" },
      }).then(m => m.default);

      const searchTerm = (country as string).toLowerCase();
      const filteredAllocators = allocators.filter(allocator => {
        const allocatorCountry = allocator.fields["Country"]?.toLowerCase() || '';
        return allocatorCountry.includes(searchTerm);
      });

      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify({
              country: country,
              count: filteredAllocators.length,
              allocators: filteredAllocators
            }, null, 2),
            mimeType: "application/json",
          },
        ],
      };
    } catch (error) {
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify({ error: `Failed to filter allocators by country: ${error}` }),
            mimeType: "application/json",
          },
        ],
      };
    }
  }
);

server.resource(
  "data-summary",
  "data://summary",
  {
    description: "Get summary statistics for funds and allocators data",
    title: "Data Summary",
    mimeType: "application/json",
  },
  async uri => {
    try {
      const [funds, allocators] = await Promise.all([
        import("../airtable_funds.json", { with: { type: "json" } }).then(m => m.default),
        import("../airtable_allocators.json", { with: { type: "json" } }).then(m => m.default)
      ]);

      // Calculate statistics
      const fundsByStatus = funds.reduce((acc, fund) => {
        const status = fund.fields["Fundraising Status"] || 'Unknown';
        acc[status] = (acc[status] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      const allocatorsByType = allocators.reduce((acc, allocator) => {
        const type = allocator.fields["Investor Type"] || 'Unknown';
        acc[type] = (acc[type] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      const allocatorsByCountry = allocators.reduce((acc, allocator) => {
        const country = allocator.fields["Country"] || 'Unknown';
        acc[country] = (acc[country] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      const summary = {
        funds: {
          total: funds.length,
          byStatus: fundsByStatus,
          lastUpdated: new Date().toISOString()
        },
        allocators: {
          total: allocators.length,
          byType: allocatorsByType,
          byCountry: allocatorsByCountry,
          lastUpdated: new Date().toISOString()
        }
      };

      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(summary, null, 2),
            mimeType: "application/json",
          },
        ],
      };
    } catch (error) {
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify({ error: `Failed to generate summary: ${error}` }),
            mimeType: "application/json",
          },
        ],
      };
    }
  }
);
server.prompt(
  "side-letter-system",
  "The standard system prompt for Side Letter AI assistant",
  {},
  ({ }) => {
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: SIDE_LETTER_SYSTEM_PROMPT
          }
        }
      ]
    };
  }
);
// ============================================================================
// UNIFIED AUTHENTICATION HELPER - SUPPORTS OAUTH, HEADER, AND URL PARAMS
// ============================================================================
function authenticateRequest(
  req: Request,
  accessTokens: Map<string, AccessTokenData>,
  apiKeyService: ApiKeyService
): {
  isValid: boolean;
  apiKey: string | null;
  method: 'oauth' | 'header' | 'url' | 'none';
  error?: string;
} {
  // Method 1: OAuth Bearer Token
  const authHeader = req.headers['authorization'];
  if (authHeader) {
    const token = authHeader.replace(/^Bearer\s+/i, '');
    const tokenData = accessTokens.get(token);
    if (tokenData && tokenData.expires_at > Date.now()) {
      console.log('✓ OAuth token validated');
      return { isValid: true, apiKey: tokenData.api_key, method: 'oauth' };
    }
  }

  // Method 2: Direct API Key Header
  const apiKeyHeader = req.headers['x-api-key'] as string;
  if (apiKeyHeader) {
    const validation = apiKeyService.validateApiKey(apiKeyHeader);
    if (validation.isValid) {
      console.log('✓ Direct API key validated (header)');
      return { isValid: true, apiKey: apiKeyHeader, method: 'header' };
    }
  }

  // Method 3: URL Parameters (email + api_key)
  const emailParam = req.query.email as string;
  const apiKeyParam = req.query.api_key as string;

  if (emailParam && apiKeyParam) {
    console.log('=== URL Parameter Authentication ===');
    console.log('Email:', emailParam);
    console.log('API Key:', apiKeyParam.substring(0, 20) + '...');

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(emailParam)) {
      return {
        isValid: false,
        apiKey: null,
        method: 'url',
        error: 'Invalid email format'
      };
    }

    const validation = apiKeyService.validateApiKey(apiKeyParam, emailParam);

    if (validation.isValid) {
      console.log('✓ URL parameter authentication successful');
      return { isValid: true, apiKey: apiKeyParam, method: 'url' };
    } else {
      let errorMsg = 'Invalid API key';
      if (validation.emailRequired) {
        errorMsg = 'Email required for first-time API key use';
      } else if (validation.emailMismatch) {
        errorMsg = `Email mismatch. Key is bound to: ${validation.boundEmail}`;
      }
      console.log('✗ URL parameter authentication failed:', errorMsg);
      return { isValid: false, apiKey: null, method: 'url', error: errorMsg };
    }
  }

  return { isValid: false, apiKey: null, method: 'none', error: 'No authentication provided' };
}

async function main() {
  try {
    apiKeyService.rehydrateTokens(accessTokens);
    console.log('✓ Rehydrated persisted tokens from disk');
    // REQUIRED: OAuth Protected Resource Metadata (RFC 9728)
    // MCP clients discover authorization servers through this endpoint
    app.get("/.well-known/oauth-protected-resource", (req: Request, res: Response) => {
      const baseUrl = getBaseUrl();
      res.json({
        resource: baseUrl,
        authorization_servers: [baseUrl],
        bearer_methods_supported: ["header"],
        resource_documentation: `${baseUrl}/docs`,
        scopes_supported: ["mcp:*"]
      });
    });

    const oauthConfig = (req: Request, res: Response) => {
      const baseUrl = getBaseUrl();
      res.json({
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        registration_endpoint: `${baseUrl}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256", "plain"],
        scopes_supported: ["openid", "profile", "claudeai", "mcp:*"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["none"]
      });
    };

    app.get("/.well-known/openid-configuration", oauthConfig);
    app.get("/.well-known/oauth-authorization-server", oauthConfig);
    app.get("/.well-known/oauth-authorization-server/mcp", oauthConfig);

    // Handle root GET - return server info
    app.get("/", (req: Request, res: Response) => {
      res.status(200).json({
        name: "Side Letter MCP Server",
        version: "1.0.0",
        endpoints: {
          mcp: "/mcp",
          oauth_discovery: "/.well-known/oauth-protected-resource",
          authorization: "/authorize",
          token: "/token"
        }
      });
    });

    app.get("/authorize", (req: Request, res: Response) => {
      const { client_id, response_type, code_challenge, code_challenge_method, redirect_uri, state, scope } = req.query;

      if (!code_challenge || !redirect_uri || !state) {
        return res.status(400).send('Missing required OAuth parameters');
      }

      res.send(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Authorize Side Letter MCP Server</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            background: white;
            padding: 40px;
            border-radius: 16px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            max-width: 500px;
            width: 100%;
        }
        h1 { color: #333; margin-bottom: 10px; font-size: 24px; }
        .subtitle { color: #666; margin-bottom: 30px; font-size: 14px; }
        .info-box {
            background-color: #e7f3ff;
            padding: 15px;
            border-radius: 8px;
            margin-bottom: 25px;
            border-left: 4px solid #2196F3;
        }
        .info-box p { color: #004085; font-size: 14px; line-height: 1.6; }
        label { display: block; margin-bottom: 8px; color: #555; font-weight: 600; font-size: 14px; }
        input[type="email"], input[type="password"] {
            width: 100%;
            padding: 12px;
            margin-bottom: 20px;
            border: 2px solid #e0e0e0;
            border-radius: 8px;
            font-size: 14px;
            transition: border-color 0.3s;
        }
        input[type="email"]:focus, input[type="password"]:focus { outline: none; border-color: #667eea; }
        button {
            width: 100%;
            padding: 14px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            font-size: 16px;
            font-weight: 600;
            transition: transform 0.2s;
        }
        button:hover { transform: translateY(-2px); }
        button:active { transform: translateY(0); }
        .help-text {
            margin-top: 20px;
            padding-top: 20px;
            border-top: 1px solid #e0e0e0;
            font-size: 12px;
            color: #666;
            text-align: center;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🔐 Authorize MCP Server</h1>
        <p class="subtitle">Side Letter Knowledge Base</p>
        <div class="info-box">
            <p><strong>Claude is requesting access</strong><br>
            Please enter your email and API key to authorize Claude to access your Side Letter knowledge base.</p>
        </div>
        <form method="POST" action="/authorize">
            <input type="hidden" name="client_id" value="${client_id || ''}">
            <input type="hidden" name="response_type" value="${response_type || ''}">
            <input type="hidden" name="code_challenge" value="${code_challenge || ''}">
            <input type="hidden" name="code_challenge_method" value="${code_challenge_method || 'S256'}">
            <input type="hidden" name="redirect_uri" value="${redirect_uri || ''}">
            <input type="hidden" name="state" value="${state || ''}">
            <input type="hidden" name="scope" value="${scope || ''}">
            
            <label for="email">Email Address</label>
            <input type="email" id="email" name="email" required placeholder="Enter your email" autocomplete="email">
            
            <label for="api_key">API Key</label>
            <input type="password" id="api_key" name="api_key" required placeholder="Enter your API key" autocomplete="off">
            
            <button type="submit">Authorize Access</button>
        </form>
        <div class="help-text">
            Your email will be linked to your API key for security. The same API key cannot be used with different emails.
        </div>
    </div>
</body>
</html>
      `);
    });

    app.post("/authorize", (req: Request, res: Response) => {
      const { client_id, response_type, code_challenge, code_challenge_method, redirect_uri, state, api_key, email } = req.body;

      const validation = apiKeyService.validateApiKey(api_key, email);

      if (!validation.isValid) {
        let errorMessage = 'Invalid API key. Please check your API key and try again.';

        if (validation.emailRequired) {
          errorMessage = 'This API key requires an email address for first-time use. Please provide your email.';
        } else if (validation.emailMismatch) {
          errorMessage = `This API key is already registered to ${validation.boundEmail}. Please use the correct email or contact your administrator.`;
        }

        return res.status(403).send(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Authorization Failed</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 500px; margin: 50px auto; padding: 20px; background-color: #f5f5f5; }
        .error { background-color: #f8d7da; color: #721c24; padding: 30px; border-radius: 8px; border: 1px solid #f5c6cb; }
        h1 { margin-top: 0; }
        p { margin: 15px 0; }
        a { display: inline-block; margin-top: 20px; color: #004085; text-decoration: none; padding: 10px 20px; background-color: #cce5ff; border-radius: 4px; }
        a:hover { background-color: #b8daff; }
    </style>
</head>
<body>
    <div class="error">
        <h1>❌ Authorization Failed</h1>
        <p>${errorMessage}</p>
        <a href="/authorize?client_id=${client_id}&response_type=${response_type}&code_challenge=${code_challenge}&code_challenge_method=${code_challenge_method}&redirect_uri=${encodeURIComponent(redirect_uri)}&state=${state}">← Try Again</a>
    </div>
</body>
</html>
        `);
      }

      console.log('✓ API key validated for:', validation.keyType, 'user', validation.boundEmail ? `(${validation.boundEmail})` : '');

      const authCode = 'mcp_auth_code_' + crypto.randomBytes(32).toString('hex');
      authCodes.set(authCode, {
        code_challenge: code_challenge as string,
        code_challenge_method: (code_challenge_method as string) || 'S256',
        redirect_uri: redirect_uri as string,
        client_id: client_id as string,
        api_key: api_key as string,
        created_at: Date.now()
      });

      const redirectUrl = new URL(redirect_uri as string);
      redirectUrl.searchParams.set('code', authCode);
      redirectUrl.searchParams.set('state', state as string);
      res.redirect(redirectUrl.toString());
    });

    app.post("/token", (req: Request, res: Response) => {
      const { grant_type, code, redirect_uri, code_verifier } = req.body;

      if (grant_type !== 'authorization_code') {
        return res.status(400).json({ error: 'unsupported_grant_type' });
      }

      const authCodeData = authCodes.get(code);
      if (!authCodeData) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid authorization code' });
      }

      if (authCodeData.redirect_uri !== redirect_uri) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'Redirect URI mismatch' });
      }

      if (code_verifier && !verifyCodeChallenge(code_verifier, authCodeData.code_challenge, authCodeData.code_challenge_method)) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
      }

      authCodes.delete(code);

      const accessToken = 'mcp_access_token_' + crypto.randomBytes(32).toString('hex');
      const refreshToken = 'mcp_refresh_token_' + crypto.randomBytes(32).toString('hex');
      const expiresIn = 7776000;  // 90 days
      const refreshExpiresIn = 15552000;  // 180 days
      accessTokens.set(accessToken, {
        api_key: authCodeData.api_key,
        created_at: Date.now(),
        expires_at: Date.now() + (expiresIn * 1000)
      });
      accessTokens.set(refreshToken, {
        api_key: authCodeData.api_key,
        created_at: Date.now(),
        expires_at: Date.now() + (refreshExpiresIn * 1000)
      });
      apiKeyService.persistTokensForKey(authCodeData.api_key, {
        accessToken,
        refreshToken,
        tokenExpiresAt: Date.now() + (expiresIn * 1000),
        refreshTokenExpiresAt: Date.now() + (refreshExpiresIn * 1000)
      });
      console.log('✓ Access token generated');
      res.json({
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: 'Bearer',
        expires_in: expiresIn,
        scope: 'claudeai'
      });
    });


    // Refresh token endpoint
    app.post("/refresh", (req: Request, res: Response) => {
      const { grant_type, refresh_token } = req.body;

      if (grant_type !== 'refresh_token') {
        return res.status(400).json({ error: 'unsupported_grant_type' });
      }

      const tokenData = accessTokens.get(refresh_token);
      if (!tokenData) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid refresh token' });
      }

      if (Date.now() > tokenData.expires_at) {
        accessTokens.delete(refresh_token);
        return res.status(400).json({ error: 'invalid_grant', error_description: 'Refresh token expired' });
      }

      // Generate new access token
      const newAccessToken = 'mcp_access_token_' + crypto.randomBytes(32).toString('hex');
      const expiresIn = 7776000;  // 90 days

      accessTokens.set(newAccessToken, {
        api_key: tokenData.api_key,
        created_at: Date.now(),
        expires_at: Date.now() + (expiresIn * 1000)
      });

      apiKeyService.updateAccessToken(tokenData.api_key, newAccessToken, Date.now() + (expiresIn * 1000));
      console.log('✓ Access token refreshed');
      res.json({
        access_token: newAccessToken,
        token_type: 'Bearer',
        expires_in: expiresIn,
        scope: 'claudeai'
      });
    });
    // Dynamic Client Registration endpoint (RFC 7591)
    app.post("/register", (req: Request, res: Response) => {
      const { client_name, redirect_uris, logo_uri, grant_types } = req.body;

      // Generate a client_id for this registration
      const clientId = 'mcp_client_' + crypto.randomBytes(16).toString('hex');

      console.log('✓ Client registered:', client_name || 'Unnamed Client');

      // Return client credentials (no client_secret for public clients)
      res.json({
        client_id: clientId,
        client_name: client_name || 'MCP Client',
        redirect_uris: redirect_uris || [],
        grant_types: grant_types || ['authorization_code'],
        token_endpoint_auth_method: 'none',
        client_id_issued_at: Math.floor(Date.now() / 1000)
      });
    });
    // Session storage for admin authentication
    interface AdminSession {
      adminKey: string;
      createdAt: number;
      expiresAt: number;
    }

    const adminSessions = new Map<string, AdminSession>();

    // Clean up expired sessions every 5 minutes
    setInterval(() => {
      const now = Date.now();
      for (const [sessionId, session] of adminSessions.entries()) {
        if (now > session.expiresAt) {
          adminSessions.delete(sessionId);
        }
      }
    }, 5 * 60 * 1000);

    // Admin login endpoint
    app.post("/admin/login", (req: Request, res: Response) => {
      const { admin_key } = req.body;

      if (!apiKeyService.isAdminKey(admin_key)) {
        return res.status(403).json({ success: false, message: 'Invalid admin key' });
      }

      // Create session
      const sessionId = 'admin_session_' + crypto.randomBytes(32).toString('hex');
      const expiresIn = 60 * 60 * 1000; // 1 hour

      adminSessions.set(sessionId, {
        adminKey: admin_key,
        createdAt: Date.now(),
        expiresAt: Date.now() + expiresIn
      });

      console.log('✓ Admin logged in');

      res.json({ success: true, sessionId, expiresIn });
    });

    // Admin logout endpoint
    app.post("/admin/logout", (req: Request, res: Response) => {
      const sessionId = req.headers['x-session-id'] as string;

      if (sessionId && adminSessions.has(sessionId)) {
        adminSessions.delete(sessionId);
        console.log('✓ Admin logged out');
      }

      res.json({ success: true });
    });

    // Middleware to check admin session
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

      // Extend session
      session.expiresAt = Date.now() + (60 * 60 * 1000);
      next();
    }

    // Admin API endpoints
    app.get("/admin/api/tokens", requireAdminSession, (req: Request, res: Response) => {
      const tokens = apiKeyService.listUserApiKeys();
      const stats = apiKeyService.getStats();
      res.json({ success: true, tokens, stats });
    });

    app.post("/admin/api/tokens", requireAdminSession, (req: Request, res: Response) => {
      const { email } = req.body as { email?: string };

      // Require email
      if (!email) {
        return res.status(400).json({
          success: false,
          message: "Email is required to create a token",
        });
      }

      // Auto-generate a unique API key
      const generatedKey = "user_" + crypto.randomBytes(24).toString("hex"); // 48-char hex

      const result = apiKeyService.addUserApiKey(generatedKey, email);

      if (!result.success) {
        return res.json(result);
      }

      // Build the non-OAuth URL for this user
      // Format: https://your-server.com/mcp?email=user@example.com&api_key=user_xxxxx
      const baseUrl = getBaseUrl();
      const nonOAuthUrl = `${baseUrl}/mcp?email=${encodeURIComponent(email)}&api_key=${encodeURIComponent(generatedKey)}`;

      return res.json({
        success: true,
        message: `Token generated successfully for ${email}`,
        apiKey: generatedKey,
        nonOAuthUrl: nonOAuthUrl,
      });
    });

    app.delete("/admin/api/tokens/:key", requireAdminSession, (req: Request, res: Response) => {
      const keyToDelete = req.params.key;

      // Find full key if partial provided
      let fullKey = keyToDelete;
      if (keyToDelete.length < 30) {
        const tokens = apiKeyService.listUserApiKeys();
        const found = tokens.find(t => t.key.startsWith(keyToDelete));
        if (found) {
          fullKey = found.key;
        }
      }

      const result = apiKeyService.removeUserApiKey(fullKey);
      if (result.success) {
        if ((result as any).removedAccessToken) accessTokens.delete((result as any).removedAccessToken);
        if ((result as any).removedRefreshToken) accessTokens.delete((result as any).removedRefreshToken);
      }
      res.json(result);
    });

    // Admin dashboard HTML page
    app.get("/admin", (req: Request, res: Response) => {
      res.send(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin Dashboard - API Token Management</title>
    <style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    background: #f8f9fa;
    min-height: 100vh;
    color: #212529;
    line-height: 1.5;
}
.container {
    max-width: 1400px;
    margin: 0 auto;
    padding: 24px;
}
.header {
    background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
    color: white;
    padding: 24px 32px;
    border-radius: 8px;
    margin-bottom: 24px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
}
.header-content {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
}
.header h1 { 
    font-size: 24px;
    font-weight: 600;
    margin-bottom: 4px;
}
.header p { 
    opacity: 0.9;
    font-size: 14px;
}
.login-card {
    background: white;
    padding: 40px;
    border-radius: 8px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    max-width: 420px;
    margin: 80px auto;
    border: 1px solid #e5e7eb;
}
.login-card h1 {
    font-size: 20px;
    font-weight: 600;
    margin-bottom: 8px;
    color: #111827;
    text-align: center;
}
.login-card > p {
    font-size: 14px;
    color: #6b7280;
    margin-bottom: 24px;
    text-align: center;
}
.card {
    background: white;
    padding: 24px;
    border-radius: 8px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    margin-bottom: 24px;
    border: 1px solid #e5e7eb;
}
.card h2 {
    margin-bottom: 20px;
    color: #111827;
    font-size: 18px;
    font-weight: 600;
}
.stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 16px;
    margin-bottom: 24px;
}
.stat-box {
    background: white;
    border: 1px solid #e5e7eb;
    padding: 20px;
    border-radius: 8px;
    box-shadow: 0 1px 2px rgba(0,0,0,0.05);
}
.stat-box .number { 
    font-size: 28px;
    font-weight: 700;
    margin-bottom: 4px;
    color: #4f46e5;
}
.stat-box .label { 
    font-size: 13px;
    color: #6b7280;
    font-weight: 500;
}
.table-container {
    overflow-x: auto;
    margin: 0 -24px;
    padding: 0 24px;
}
table {
    width: 100%;
    border-collapse: collapse;
    font-size: 14px;
}
th, td {
    padding: 12px 16px;
    text-align: left;
    border-bottom: 1px solid #e5e7eb;
}
th {
    background: #f9fafb;
    font-weight: 600;
    color: #374151;
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.025em;
}
tbody tr:hover { 
    background: #f9fafb;
}
.token-key {
    font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
    background: #f3f4f6;
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 12px;
    color: #1f2937;
}
.badge {
    display: inline-flex;
    align-items: center;
    padding: 4px 10px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 500;
}
.badge-success { 
    background: #d1fae5;
    color: #065f46;
}
.badge-warning { 
    background: #fef3c7;
    color: #92400e;
}
input {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    font-size: 14px;
    margin-bottom: 12px;
    transition: border-color 0.15s, box-shadow 0.15s;
}
input:focus {
    outline: none;
    border-color: #4f46e5;
    box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.1);
}
button {
    width: 100%;
    padding: 10px 16px;
    background: #4f46e5;
    color: white;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-weight: 500;
    font-size: 14px;
    transition: background 0.15s;
    margin-bottom: 0;
}
button:hover { 
    background: #4338ca;
}
button:disabled {
    background: #9ca3af;
    cursor: not-allowed;
}
.btn-danger {
    background: #ef4444;
    padding: 6px 12px;
    border-radius: 6px;
    border: none;
    color: white;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    width: auto;
    margin: 0;
}
.btn-danger:hover { 
    background: #dc2626;
}
.btn-small {
    width: auto;
    padding: 10px 16px;
    margin: 0;
    font-size: 14px;
    white-space: nowrap;
}
.form-row {
    display: flex;
    gap: 12px;
    align-items: flex-end;
}
.form-row input {
    flex: 1;
    margin-bottom: 0;
}
.error { 
    color: #991b1b;
    padding: 12px;
    background: #fee2e2;
    border-radius: 6px;
    margin-bottom: 16px;
    font-size: 14px;
    border: 1px solid #fecaca;
}
.success { 
    color: #065f46;
    padding: 12px;
    background: #d1fae5;
    border-radius: 6px;
    margin-bottom: 16px;
    font-size: 14px;
    border: 1px solid #a7f3d0;
}
.hidden { display: none; }
.logout-btn {
    background: rgba(255,255,255,0.15);
    border: 1px solid rgba(255,255,255,0.3);
    padding: 8px 16px;
    width: auto;
    margin: 0;
    font-size: 14px;
    backdrop-filter: blur(10px);
}
.logout-btn:hover {
    background: rgba(255,255,255,0.25);
}
.empty-state {
    text-align: center;
    padding: 48px 24px;
    color: #6b7280;
}
.generated-credentials {
    margin-top: 20px;
    padding: 20px;
    background: #f0fdf4;
    border-radius: 8px;
    border: 1px solid #bbf7d0;
}
.generated-credentials h3 {
    margin-top: 0;
    margin-bottom: 16px;
    color: #166534;
    font-size: 16px;
    font-weight: 600;
}
.credential-item {
    margin-bottom: 16px;
}
.credential-item:last-child {
    margin-bottom: 0;
}
.credential-label {
    display: block;
    margin-bottom: 6px;
    font-weight: 500;
    font-size: 13px;
    color: #374151;
}
.credential-input-group {
    display: flex;
    gap: 8px;
}
.credential-input-group input {
    flex: 1;
    padding: 10px 12px;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
    font-size: 13px;
    background: white;
    margin-bottom: 0;
}
.credential-input-group button {
    width: auto;
    padding: 10px 16px;
    white-space: nowrap;
    font-size: 13px;
}
.usage-note {
    margin-top: 12px;
    padding: 12px;
    background: white;
    border-radius: 6px;
    font-size: 13px;
    color: #4b5563;
    line-height: 1.6;
    border: 1px solid #e5e7eb;
}
.btn-action {
    background: #6366f1;
    padding: 6px 12px;
    border-radius: 6px;
    border: none;
    color: white;
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
    width: auto;
    margin: 0;
    white-space: nowrap;
}
.btn-action:hover { 
    background: #4f46e5;
}

/* Toast animations */
@keyframes slideIn {
    from {
        transform: translateX(400px);
        opacity: 0;
    }
    to {
        transform: translateX(0);
        opacity: 1;
    }
}
@keyframes slideOut {
    from {
        transform: translateX(0);
        opacity: 1;
    }
    to {
        transform: translateX(400px);
        opacity: 0;
    }
}

/* Update Actions column header */
th:last-child {
    min-width: 180px;
}

.usage-note strong {
    color: #111827;
}
@media (max-width: 768px) {
    .container { padding: 16px; }
    .header { padding: 20px; }
    .card { padding: 20px; }
    .form-row { flex-direction: column; }
    .form-row .btn-small { width: 100%; }
    .stats { grid-template-columns: 1fr; }
    table { font-size: 13px; }
    th, td { padding: 10px 12px; }
}
</style>
</head>
<body>
    <div id="loginPage" class="hidden">
        <div class="login-card">
            <h1>🔐 Admin Login</h1>
            <p>API Token Management Dashboard</p>
            <div id="loginError" class="error hidden"></div>
            <form id="loginForm">
                <input type="password" id="adminKey" placeholder="Enter Admin API Key" required>
                <button type="submit">Login</button>
            </form>
        </div>
    </div>

    <div id="dashboardPage" class="hidden">
        <div class="container">
            <div class="header">
                <div class="header-content">
                    <div>
                        <h1>🔑 API Token Management</h1>
                        <p>Manage user API tokens and email bindings</p>
                    </div>
                    <button class="logout-btn" onclick="logout()">Logout</button>
                </div>
            </div>

            <div class="stats" id="stats"></div>

            <div class="card">
                <h2>➕ Add New Token</h2>
                <div id="addMessage" class="hidden"></div>
                <form id="addTokenForm">
                    <div class="form-row">
                        <input type="email" id="newEmail" placeholder="User email" required>
                        <button type="submit" class="btn-small">Generate Token & URL</button>
                    </div>
                </form>
                <div id="generatedTokenInfo" class="hidden generated-credentials">
                    <h3>✅ Generated Credentials</h3>
                    <div class="credential-item">
                        <label class="credential-label">API Key:</label>
                        <div class="credential-input-group">
                            <input type="text" id="generatedKey" readonly>
                            <button onclick="copyToClipboard('generatedKey')" class="btn-small">📋 Copy</button>
                        </div>
                    </div>
                    <div class="credential-item">
                        <label class="credential-label">Non-OAuth Connection URL:</label>
                        <div class="credential-input-group">
                            <input type="text" id="generatedUrl" readonly>
                            <button onclick="copyToClipboard('generatedUrl')" class="btn-small">📋 Copy</button>
                        </div>
                        <div class="usage-note">
                            <strong>💡 Usage:</strong> Users can add this URL directly to their MCP client config for clients that don't support OAuth yet.
                        </div>
                    </div>
                </div>
            </div>

            <div class="card">
                <h2>📋 User API Tokens</h2>
                <div id="tokensTable"></div>
            </div>
        </div>
    </div>

    <script>
        let sessionId = localStorage.getItem('admin_session');
        
        // Check session on load
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
                    localStorage.setItem('admin_session', sessionId);
                    loadDashboard();
                } else {
                    errorDiv.textContent = data.message || 'Invalid admin key';
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
                    <div class="number">\${stats.boundKeys}</div>
                    <div class="label">Bound to Email</div>
                </div>
                <div class="stat-box">
                    <div class="number">\${stats.unboundKeys}</div>
                    <div class="label">Unbound</div>
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
                tableDiv.innerHTML = '<div class="empty-state">No user tokens found. Add one above!</div>';
                return;
            }
            
            const baseUrl = window.location.origin;
            
            const tableHtml = \`
                <div class="table-container">
                    <table>
                        <thead>
                            <tr>
                                <th>API Key</th>
                                <th>Email</th>
                                <th>Created</th>
                                <th>Last Used</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            \${tokens.map(token => {
                                const fullUrl = token.email 
                                    ? \`\${baseUrl}/mcp?email=\${encodeURIComponent(token.email)}&api_key=\${token.key}\`
                                    : '';
                                return \`
                                <tr>
                                    <td><span class="token-key" title="\${token.key}">\${token.key.substring(0, 20)}...</span></td>
                                    <td>
                                        \${token.email 
                                            ? \`<span class="badge badge-success">\${token.email}</span>\`
                                            : '<span class="badge badge-warning">Not bound</span>'}
                                    </td>
                                    <td>\${new Date(token.createdAt).toLocaleDateString()}</td>
                                    <td>\${token.lastUsed ? new Date(token.lastUsed).toLocaleDateString() : 'Never'}</td>
                                    <td>
                                        <div style="display: flex; gap: 6px; flex-wrap: wrap;">
                                            <button class="btn-action" onclick="copyApiKey('\${token.key}')" title="Copy API Key">
                                                📋 Key
                                            </button>
                                            \${token.email ? \`
                                                <button class="btn-action" onclick="copyUrl('\${token.email}', '\${token.key}')" title="Copy Connection URL">
                                                    🔗 URL
                                                </button>
                                            \` : ''}
                                            <button class="btn-danger" onclick="deleteToken('\${token.key.substring(0, 20)}')">
                                                🗑️
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            \`;
                            }).join('')}
                        </tbody>
                    </table>
                </div>
            \`;
            tableDiv.innerHTML = tableHtml;
        }

        function copyApiKey(apiKey) {
            navigator.clipboard.writeText(apiKey).then(() => {
                showToast('✅ API Key copied to clipboard!');
            }).catch(err => {
                // Fallback for older browsers
                const textarea = document.createElement('textarea');
                textarea.value = apiKey;
                document.body.appendChild(textarea);
                textarea.select();
                document.execCommand('copy');
                document.body.removeChild(textarea);
                showToast('✅ API Key copied to clipboard!');
            });
        }

        function copyUrl(email, apiKey) {
            const baseUrl = window.location.origin;
            const fullUrl = \`\${baseUrl}/mcp?email=\${encodeURIComponent(email)}&api_key=\${apiKey}\`;
            
            navigator.clipboard.writeText(fullUrl).then(() => {
                showToast('✅ Connection URL copied to clipboard!');
            }).catch(err => {
                // Fallback for older browsers
                const textarea = document.createElement('textarea');
                textarea.value = fullUrl;
                document.body.appendChild(textarea);
                textarea.select();
                document.execCommand('copy');
                document.body.removeChild(textarea);
                showToast('✅ Connection URL copied to clipboard!');
            });
        }

        function showToast(message) {
            // Remove existing toast if any
            const existingToast = document.getElementById('toast');
            if (existingToast) {
                existingToast.remove();
            }

            // Create toast
            const toast = document.createElement('div');
            toast.id = 'toast';
            toast.textContent = message;
            toast.style.cssText = \`
                position: fixed;
                bottom: 24px;
                right: 24px;
                background: #111827;
                color: white;
                padding: 12px 20px;
                border-radius: 8px;
                font-size: 14px;
                font-weight: 500;
                box-shadow: 0 4px 6px rgba(0,0,0,0.1);
                z-index: 10000;
                animation: slideIn 0.3s ease;
            \`;
            
            document.body.appendChild(toast);
            
            // Remove after 3 seconds
            setTimeout(() => {
                toast.style.animation = 'slideOut 0.3s ease';
                setTimeout(() => toast.remove(), 300);
            }, 3000);
        }

        document.getElementById('addTokenForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const messageDiv = document.getElementById('addMessage');
            const generatedInfoDiv = document.getElementById('generatedTokenInfo');
            const newEmail = document.getElementById('newEmail').value;
            
            // Hide previous generated info
            generatedInfoDiv.classList.add('hidden');
            
            try {
                const response = await fetch('/admin/api/tokens', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Session-Id': sessionId
                    },
                    body: JSON.stringify({ email: newEmail })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    messageDiv.className = 'success';
                    messageDiv.textContent = '✅ ' + data.message;
                    
                    // Display the generated credentials
                    document.getElementById('generatedKey').value = data.apiKey;
                    document.getElementById('generatedUrl').value = data.nonOAuthUrl;
                    generatedInfoDiv.classList.remove('hidden');
                    
                    document.getElementById('addTokenForm').reset();
                    setTimeout(() => loadDashboard(), 2000);
                } else {
                    messageDiv.className = 'error';
                    messageDiv.textContent = '❌ ' + data.message;
                }
                messageDiv.classList.remove('hidden');
                setTimeout(() => messageDiv.classList.add('hidden'), 5000);
            } catch (error) {
                messageDiv.className = 'error';
                messageDiv.textContent = 'Failed to add token: ' + error.message;
                messageDiv.classList.remove('hidden');
            }
        });

        function copyToClipboard(elementId) {
            const input = document.getElementById(elementId);
            input.select();
            document.execCommand('copy');
            
            // Visual feedback
            const button = event.target;
            const originalText = button.textContent;
            button.textContent = '✅ Copied!';
            setTimeout(() => {
                button.textContent = originalText;
            }, 2000);
        }

        async function deleteToken(partialKey) {
            if (!confirm('Are you sure you want to delete this token?')) return;
            
            try {
                const response = await fetch(\`/admin/api/tokens/\${partialKey}\`, {
                    method: 'DELETE',
                    headers: { 'X-Session-Id': sessionId }
                });
                
                const data = await response.json();
                
                if (data.success) {
                    loadDashboard();
                } else {
                    alert('Failed to delete: ' + data.message);
                }
            } catch (error) {
                alert('Failed to delete token: ' + error.message);
            }
        }

        async function logout() {
            try {
                await fetch('/admin/logout', {
                    method: 'POST',
                    headers: { 'X-Session-Id': sessionId }
                });
            } catch (error) {
                console.error('Logout failed:', error);
            }
            
            sessionId = null;
            localStorage.removeItem('admin_session');
            showLogin();
            document.getElementById('loginForm').reset();
        }

        // Auto-refresh dashboard every 30 seconds
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
  app.post("/mcp", async (req: Request, res: Response) => {
    const auth = authenticateRequest(req, accessTokens, apiKeyService);

    if (!auth.isValid) {
      const baseUrl = getBaseUrl();
      res.set('WWW-Authenticate', `Bearer realm="${baseUrl}", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`);
      return res.status(401).json({
        error: 'Authentication required',
        details: auth.error,
        method: auth.method
      });
    }

    const httpserver = server;
    const httpTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      httpTransport.close();
      httpserver.close();
    });
    await httpserver.connect(httpTransport);
    await httpTransport.handleRequest(req, res, req.body);
  });

  // Also handle POST at root (/) for clients that use base URL as MCP endpoint
  app.post("/", async (req: Request, res: Response) => {
    const auth = authenticateRequest(req, accessTokens, apiKeyService);

    if (!auth.isValid) {
      const baseUrl = getBaseUrl();
      res.set('WWW-Authenticate', `Bearer realm="${baseUrl}", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`);
      return res.status(401).json({
        error: 'Authentication required',
        details: auth.error,
        method: auth.method
      });
    }

    console.log('✓ Authentication successful at root endpoint via', auth.method);

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
    console.log(`Side Letter MCP Server running`);
    console.log(`${'='.repeat(60)}`);
    console.log(`Local: http://localhost:${PORT}`);
    console.log(`Public: ${getBaseUrl()}`);
    console.log(`\nEndpoints:`);
    console.log(`  - OAuth Discovery: /.well-known/openid-configuration`);
    console.log(`  - Authorization: /authorize`);
    console.log(`  - Token Exchange: /token`);
    console.log(`  - MCP: /mcp`);
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