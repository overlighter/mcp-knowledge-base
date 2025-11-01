import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js"; // <-- ADD THIS
import { z } from "zod";
import dotenv from 'dotenv';
import express,{Request,Response} from 'express';
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RagieService } from './ragieService.js';
import { AirtableService } from './airtableService.js';
import fs from "fs";
import path from "path";
const app = express()
app.use(express.json())
// Load environment variables from the project root, regardless of working directory
const projectRoot = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(projectRoot, '.env') });
// Load environment variables
// dotenv.config();
// const RAGIE_API_KEY = process.env.RAGIE_API_KEY || '';

// Initialize Ragie service
// const ragieService = new RagieService(RAGIE_API_KEY);
const ragieService = new RagieService("tnt_JdgN2vTLRVd_uyxjbRI6iWJYttXGYX9vOsWdSDgOuWloz3MtgcNbvOJ")

// Initialize Airtable service
const airtableService = new AirtableService();

// Create server instance
const server = new McpServer({
  name: 'side-letter-knowledge-base',
  version: '1.0.0',
  
  capabilities: {
    resources: {
      subscribe: true,
      listChanged: true
    },
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


// async function main() {
//   try {
//     const transport = new StdioServerTransport();
//     await server.connect(transport);
    
//     // Only log to stderr (not stdout, which is used for MCP protocol)
//     console.error('Side Letter MCP Server running on stdio');
//     console.error('Available tools: search, ask, sync_airtable, force_refresh_airtable, test_airtable_connections');
//     console.error('Available prompts: citation_guide');
//     console.error('Available resources: funds://all, allocators://all, funds://{fundId}/details, allocators://{allocatorId}/details, funds://status/{status}, allocators://type/{type}, funds://name/{fundName}, allocators://name/{investorName}, allocators://country/{country}, data://summary');
//   } catch (error) {
//     console.error('Failed to start server:', error);
//     process.exit(1);
//   }
// }

// main().catch((error) => {
//   console.error('Fatal error:', error);
//   process.exit(1);
// });
async function main() {
  try {
   
    app.post("/mcp", async (req: Request, res: Response) => {
      const httpserver = server
      const httpTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        httpTransport.close();
        httpserver.close();
      });
      await httpserver.connect(httpTransport);
      await httpTransport.handleRequest(req, res, req.body);
    
        
    })

    

  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}


main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
const PORT = 3000
app.listen(PORT, () => {
  console.error(`Side Letter MCP Server running on http://localhost:${PORT}`);
} )