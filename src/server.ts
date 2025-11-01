import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import dotenv from 'dotenv';
import express,{Request,Response, NextFunction} from 'express';
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

server.tool(
  'search',
  'Search the knowledge base using natural language queries. Returns relevant chunks with citations like all source or title or document name (Page number if available).make sure to list all the source, document name, and page number if available in the citations when given back your response from the chunk data.',
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

// server.tool(
//   'ask',
//   'Ask a question and get relevant context from the knowledge base',
//   {
//     query: z.string().describe('The question to ask'),
//     top_k: z.number().optional().default(5).describe('Number of chunks to retrieve (default: 5)'),
//     filter_by_title: z.string().optional().describe('Optional: Filter by document title'),
//     filter_by_source: z.string().optional().describe('Optional: Filter by source (e.g., Airtable)'),
//     filter_by_table: z.string().optional().describe('Optional: Filter by Airtable table name (e.g., "Funds [Master]", "Allocators [Master]")'),
//   },
//   async ({ query, top_k, filter_by_title, filter_by_source, filter_by_table }) => {
//     try {
//       // Build filter if provided
//       let filter = null;
//       if (filter_by_title || filter_by_source || filter_by_table) {
//         filter = {};
//         if (filter_by_title) {
//           (filter as any).title = { $eq: filter_by_title };
//         }
//         if (filter_by_source) {
//           (filter as any).source = { $eq: filter_by_source };
//         }
//         if (filter_by_table) {
//           (filter as any).table_name = { $eq: filter_by_table };
//         }
//       }

//       const context = await ragieService.ask(query, top_k, filter);
      
//       return {
//         content: [
//           {
//             type: 'text',
//             text: `Context for: "${query}"\n\n${context}`,
//           },
//         ],
//       };
//     } catch (error) {
//       const errorMessage = error instanceof Error ? error.message : String(error);
      
//       return {
//         content: [
//           {
//             type: 'text',
//             text: `Error retrieving context: ${errorMessage}`,
//           },
//         ],
//         isError: true,
//       };
//     }
//   }
// );

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
  'Browse and search specifically within Airtable data (Funds and Allocators)',
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



async function main() {
  try {
    // REQUIRED: OAuth Protected Resource Metadata (RFC 9728)
    // MCP clients discover authorization servers through this endpoint
    app.get("/.well-known/oauth-protected-resource", (req: Request, res: Response) => {
      const baseUrl = process.env.NGROK_URL || `http://localhost:3000`;
      res.json({
        resource: baseUrl,
        authorization_servers: [baseUrl],
        bearer_methods_supported: ["header"],
        resource_documentation: `${baseUrl}/docs`,
        scopes_supported: ["mcp:*"]
      });
    });

    const oauthConfig = (req: Request, res: Response) => {
      const baseUrl = process.env.NGROK_URL || `http://localhost:3000`;
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
        input[type="password"] {
            width: 100%;
            padding: 12px;
            margin-bottom: 20px;
            border: 2px solid #e0e0e0;
            border-radius: 8px;
            font-size: 14px;
            transition: border-color 0.3s;
        }
        input[type="password"]:focus { outline: none; border-color: #667eea; }
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
            Please enter your API key to authorize Claude to access your Side Letter knowledge base.</p>
        </div>
        <form method="POST" action="/authorize">
            <input type="hidden" name="client_id" value="${client_id || ''}">
            <input type="hidden" name="response_type" value="${response_type || ''}">
            <input type="hidden" name="code_challenge" value="${code_challenge || ''}">
            <input type="hidden" name="code_challenge_method" value="${code_challenge_method || 'S256'}">
            <input type="hidden" name="redirect_uri" value="${redirect_uri || ''}">
            <input type="hidden" name="state" value="${state || ''}">
            <input type="hidden" name="scope" value="${scope || ''}">
            <label for="api_key">API Key</label>
            <input type="password" id="api_key" name="api_key" required placeholder="Enter your API key" autocomplete="off">
            <button type="submit">Authorize Access</button>
        </form>
        <div class="help-text">Your API key will be securely validated and used to authenticate requests.</div>
    </div>
</body>
</html>
      `);
    });

    app.post("/authorize", (req: Request, res: Response) => {
      const { client_id, response_type, code_challenge, code_challenge_method, redirect_uri, state, api_key } = req.body;
      
      const validation = apiKeyService.validateApiKey(api_key);
      
      if (!validation.isValid) {
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
        a { display: inline-block; margin-top: 20px; color: #004085; text-decoration: none; padding: 10px 20px; background-color: #cce5ff; border-radius: 4px; }
        a:hover { background-color: #b8daff; }
    </style>
</head>
<body>
    <div class="error">
        <h1>❌ Authorization Failed</h1>
        <p>Invalid API key. Please check your API key and try again.</p>
        <a href="/authorize?client_id=${client_id}&response_type=${response_type}&code_challenge=${code_challenge}&code_challenge_method=${code_challenge_method}&redirect_uri=${encodeURIComponent(redirect_uri)}&state=${state}">← Try Again</a>
    </div>
</body>
</html>
        `);
      }
      
      console.log('✓ API key validated for:', validation.keyType, 'user');
      
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
      const expiresIn = 3600;
      accessTokens.set(accessToken, {
        api_key: authCodeData.api_key,
        created_at: Date.now(),
        expires_at: Date.now() + (expiresIn * 1000)
      });

      console.log('✓ Access token generated');
      res.json({ access_token: accessToken, token_type: 'Bearer', expires_in: expiresIn, scope: 'claudeai' });
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

    app.post("/mcp", async (req: Request, res: Response) => {
      const authHeader = req.headers['authorization'];
      const apiKeyHeader = req.headers['x-api-key'];
      let validatedApiKey: string | null = null;

      if (authHeader) {
        const token = authHeader.replace(/^Bearer\s+/i, '');
        const tokenData = accessTokens.get(token);
        if (tokenData && tokenData.expires_at > Date.now()) {
          validatedApiKey = tokenData.api_key;
          console.log('✓ OAuth token validated');
        }
      }

      if (!validatedApiKey && apiKeyHeader) {
        const validation = apiKeyService.validateApiKey(apiKeyHeader as string);
        if (validation.isValid) {
          validatedApiKey = apiKeyHeader as string;
          console.log('✓ Direct API key validated');
        }
      }

      if (!validatedApiKey) {
        const baseUrl = process.env.NGROK_URL || `http://localhost:3000`;
        res.set('WWW-Authenticate', `Bearer realm="${baseUrl}", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`);
        return res.status(401).json({ error: 'Authentication required' });
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
      const authHeader = req.headers['authorization'];
      const apiKeyHeader = req.headers['x-api-key'];
      let validatedApiKey: string | null = null;

      if (authHeader) {
        const token = authHeader.replace(/^Bearer\s+/i, '');
        const tokenData = accessTokens.get(token);
        if (tokenData && tokenData.expires_at > Date.now()) {
          validatedApiKey = tokenData.api_key;
          console.log('✓ OAuth token validated (root endpoint)');
        }
      }

      if (!validatedApiKey && apiKeyHeader) {
        const validation = apiKeyService.validateApiKey(apiKeyHeader as string);
        if (validation.isValid) {
          validatedApiKey = apiKeyHeader as string;
          console.log('✓ Direct API key validated (root endpoint)');
        }
      }

      if (!validatedApiKey) {
        const baseUrl = process.env.NGROK_URL || `http://localhost:3000`;
        res.set('WWW-Authenticate', `Bearer realm="${baseUrl}", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`);
        return res.status(401).json({ error: 'Authentication required' });
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

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`Side Letter MCP Server running`);
      console.log(`${'='.repeat(60)}`);
      console.log(`Local: http://localhost:${PORT}`);
      if (process.env.NGROK_URL) console.log(`Public: ${process.env.NGROK_URL}`);
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