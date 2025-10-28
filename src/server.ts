import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import dotenv from 'dotenv';

import { RagieService } from './ragieService.js';

// Load environment variables
// dotenv.config();

// const RAGIE_API_KEY = process.env.RAGIE_API_KEY || '';

// Initialize Ragie service
// const ragieService = new RagieService(RAGIE_API_KEY);
const ragieService = new RagieService("tnt_JdgN2vTLRVd_uyxjbRI6iWJYttXGYX9vOsWdSDgOuWloz3MtgcNbvOJ")

// Create server instance
const server = new McpServer({
  name: 'side-letter-knowledge-base',
  version: '1.0.0',
  capabilities: {
    resources: {},
    tools: {},
    prompts: {}
  },
});

server.tool(
  'search',
  'Search the knowledge base using natural language queries. Returns relevant chunks with citations.',
  {
    query: z.string().describe('The search query in natural language'),
    top_k: z.number().optional().default(10).describe('Number of results to return (default: 10)'),
    rerank: z.boolean().optional().default(true).describe('Use reranking for better results (default: true)'),
    filter_by_title: z.string().optional().describe('Optional: Filter by document title'),
    filter_by_type: z.string().optional().describe('Optional: Filter by document type (e.g., PDF)')
  },
  async ({ query, top_k, rerank, filter_by_title, filter_by_type }) => {
    try {
      // Build filter object if any filters are provided
      let filter = null;
      if (filter_by_title || filter_by_type) {
        filter = {};
        if (filter_by_title) {
          (filter as any).title = { $eq: filter_by_title };
        }
        if (filter_by_type) {
          (filter as any).document_type = { $eq: filter_by_type };
        }
      }

      const searchResponse = await ragieService.search(query, top_k, filter, rerank);
      
      // Format results with citations
      const formattedResults = searchResponse.results
        .map((r: any, i: number) => {
          const citation = `[${i + 1}] ${r.citation.source}${r.citation.page ? ` (Page ${r.citation.page})` : ''}`;
          const docType = r.citation.documentType ? ` [${r.citation.documentType}]` : '';
          return `${citation}${docType}\n${r.content}\nRelevance Score: ${r.score.toFixed(3)}\n`;
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
  'ask',
  'Ask a question and get relevant context from the knowledge base',
  {
    query: z.string().describe('The question to ask'),
    top_k: z.number().optional().default(5).describe('Number of chunks to retrieve (default: 5)'),
    filter_by_title: z.string().optional().describe('Optional: Filter by document title'),
  },
  async ({ query, top_k, filter_by_title }) => {
    try {
      // Build filter if provided
      let filter = null;
      if (filter_by_title) {
        filter = { title: { $eq: filter_by_title } };
      }

      const context = await ragieService.ask(query, top_k, filter);
      
      return {
        content: [
          {
            type: 'text',
            text: `Context for: "${query}"\n\n${context}`,
          },
        ],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      return {
        content: [
          {
            type: 'text',
            text: `Error retrieving context: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  'list_documents',
  'List all documents in the knowledge base',
  {
    filter_by_title: z.string().optional().describe('Optional: Filter by document title'),
    filter_by_type: z.string().optional().describe('Optional: Filter by document type'),
  },
  async ({ filter_by_title, filter_by_type }) => {
    try {
      // Build filter if provided
      let filter = null;
      if (filter_by_title || filter_by_type) {
        const filterObj = {} as any;
        if (filter_by_title) (filterObj as any).title = { $eq: filter_by_title };
        if (filter_by_type) (filterObj as any).document_type = { $eq: filter_by_type };
        filter = JSON.stringify(filterObj);
      }

      const documents = await ragieService.listDocuments(filter as any);
      
      const documentList = documents
        .map((doc: any, i: number) => {
          const name = doc.name || doc.document_name || 'Unnamed';
          const type = doc.document_type || 'Unknown type';
          const status = doc.status || 'Unknown status';
          const chunks = doc.chunk_count ? ` (${doc.chunk_count} chunks)` : '';
          return `${i + 1}. ${name} [${type}] - Status: ${status}${chunks}\n   ID: ${doc.id}`;
        })
        .join('\n\n');
      
      return {
        content: [
          {
            type: 'text',
            text: `Knowledge Base Documents (${documents.length} total):\n\n${documentList}`,
          },
        ],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      return {
        content: [
          {
            type: 'text',
            text: `Error listing documents: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  'get_document',
  'Get detailed information about a specific document',
  {
    document_id: z.string().describe('The document ID to retrieve'),
  },
  async ({ document_id }) => {
    try {
      const document = await ragieService.getDocument(document_id);
      
      const info = `Document Information:

Name: ${document.name || 'N/A'}
ID: ${document.id}
Status: ${document.status}
Type: ${document.document_type || 'N/A'}
Chunks: ${document.chunk_count || 0}
Created: ${document.created_at ? new Date(document.created_at).toLocaleString() : 'N/A'}
Updated: ${document.updated_at ? new Date(document.updated_at).toLocaleString() : 'N/A'}

Metadata:
${JSON.stringify(document.metadata || {}, null, 2)}`;
      
      return {
        content: [
          {
            type: 'text',
            text: info,
          },
        ],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      return {
        content: [
          {
            type: 'text',
            text: `Error retrieving document: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  'test_connection',
  'Test connection to Ragie API to diagnose connectivity issues',
  {},
  async () => {
    try {
      const testResult = await ragieService.testConnection();
      
      return {
        content: [
          {
            type: 'text',
            text: `Connection Test Result:\n\nStatus: ${testResult.success ? '✅ SUCCESS' : '❌ FAILED'}\nMessage: ${testResult.message}\n\nDetails: ${JSON.stringify(testResult.details, null, 2)}`,
          },
        ],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      return {
        content: [
          {
            type: 'text',
            text: `Error during connection test: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  }
);

async function main() {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    
    // Only log to stderr (not stdout, which is used for MCP protocol)
    console.error('Side Letter MCP Server running on stdio');
    console.error('Available tools: search, ask, list_documents, get_document, test_connection');
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});