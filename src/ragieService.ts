import { Ragie } from "ragie";
import * as fs from 'fs';
import * as path from 'path';

export class RagieService {
    private ragie: Ragie;
  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error('RAGIE_API_KEY is required');
    }
    
    this.ragie = new Ragie({

      auth: apiKey
    });
  }

  /**
   * Search/retrieve chunks from Ragie knowledge base
   * @param {string} query - The search query
   * @param {number} topK - Number of results to return (default: 10)
   * @param {object} filter - Optional metadata filter
   * @param {boolean} rerank - Whether to use reranking (default: true)
   * @returns {Promise<object>} Formatted search results
   */
  async search(query: string, topK: any, filter: any = null, rerank: boolean = true) {
    try {
      const requestParams = {
        query,
        top_k: topK,
        rerank
      };

      // Add filter if provided
      if (filter) {
        (requestParams as any).filter = filter;
      }

      const response = await this.ragie.retrievals.retrieve(requestParams);

      // Log the response structure to file for debugging
      try {
        const logsDir = path.join(process.cwd(), 'logs');
        if (!fs.existsSync(logsDir)) {
          fs.mkdirSync(logsDir, { recursive: true });
        }
        
        const logData = {
          timestamp: new Date().toISOString(),
          query: query,
          requestParams: requestParams,
          response: response
        };
        
        const logFile = path.join(logsDir, 'ragie-search-response.log');
        fs.appendFileSync(logFile, JSON.stringify(logData, null, 2) + '\n---\n\n');
        console.error('Response logged to:', logFile);
      } catch (logError) {
        console.error('Failed to log response:', logError);
      }

      // Check if response has the expected structure
      if (!response || typeof response !== 'object') {
        throw new Error('Invalid response from Ragie API');
      }

      // Handle different possible response structures
      let chunks = [];
      if ((response as any).scoredChunks) {
        chunks = (response as any).scoredChunks;
      } else if ((response as any).scored_chunks) {
        chunks = (response as any).scored_chunks;
      } else if ((response as any).chunks) {
        chunks = (response as any).chunks;
      } else if ((response as any).results) {
        chunks = (response as any).results;
      } else if (Array.isArray(response)) {
        chunks = response;
      } else {
        console.error('Unexpected response structure:', response);
        throw new Error('Unexpected response structure from Ragie API');
      }

      // Format the response
      const formattedResults = chunks.map((chunk: any) => ({
        content: chunk.text || chunk.content || '',
        score: chunk.score || 0,
        documentId: chunk.documentId || chunk.document_id || '',
        citation: {
          source: chunk.documentName || 
                  chunk.documentMetadata?.title || 
                  chunk.document_metadata?.document_name || 
                  chunk.document_metadata?.title || 
                  chunk.metadata?.document_name ||
                  chunk.metadata?.title ||
                  'Unknown',
          page: chunk.metadata?.start_page || 
                chunk.metadata?.end_page || 
                chunk.document_metadata?.page || 
                chunk.metadata?.page || 
                null,
          documentType: chunk.documentMetadata?.document_type || 
                       chunk.document_metadata?.document_type || 
                       chunk.metadata?.document_type || 
                       'PDF',
          // Enhanced Airtable-specific citation info
          tableName: chunk.metadata?.table_name || 
                    chunk.document_metadata?.table_name || 
                    null,
          exportType: chunk.metadata?.export_type || 
                     chunk.document_metadata?.export_type || 
                     null,
          recordCount: chunk.metadata?.record_count || 
                      chunk.document_metadata?.record_count || 
                      null,
          lastUpdated: chunk.metadata?.last_updated || 
                      chunk.document_metadata?.last_updated || 
                      null,
          dataSource: chunk.metadata?.source || 
                     chunk.document_metadata?.source || 
                     null
        },
        metadata: {
          ...chunk.metadata,
          ...chunk.documentMetadata,
          ...chunk.document_metadata,
          chunkId: chunk.id,
          index: chunk.index,
          links: chunk.links
        }
      }));

      return {
        results: formattedResults,
        totalResults: formattedResults.length,
        query
      };
    } catch (error) {
      console.error('Error in Ragie search:', error);
      throw new Error(`Failed to search Ragie: ${(error as any).message || error}`);
    }
  }

  /**
   * Ask a question and get formatted context
   * @param {string} query - The question to ask
   * @param {number} topK - Number of chunks to retrieve
   * @param {object} filter - Optional metadata filter
   * @returns {Promise<string>} Formatted context string
   */
  async ask(query: string, topK: any = 5, filter: any = null) {
    try {
      const searchResponse = await this.search(query, topK, filter);
      
      // Format chunks into a context string
      const context = (searchResponse as any).results
        .map((result: any, index: number) => {
          let citation = `[${index + 1}] ${result.citation.source}`;
          
          // Add page info if available
          if (result.citation.page) {
            citation += ` (Page ${result.citation.page})`;
          }
          
          // Add Airtable table name if available
          if (result.citation.tableName) {
            citation += ` [${result.citation.tableName}]`;
          }
          
          // Add document type
          if (result.citation.documentType) {
            citation += ` [${result.citation.documentType}]`;
          }
          
          return `${citation}\n${result.content}\n`;
        })
        .join('\n---\n\n');

      return context;
    } catch (error) {
      console.error('Error in Ragie ask:', error);
      throw new Error(`Failed to get context from Ragie: ${(error as any).message || error}`);
    }
  }

  /**
   * List all documents in the knowledge base
   * @param {object} filter - Optional filter in JSON string format
   * @returns {Promise<Array>} List of documents
   */
  async listDocuments(filter = null) {
    try {
      const requestParams = {};
      
      if (filter) {
        // Filter should be a JSON string according to Ragie docs
        (requestParams as any).filter = typeof filter === 'string' 
          ? filter 
          : JSON.stringify(filter);
      }

      const response = await (this.ragie as any).documents.list(requestParams);
      
      return (response as any).documents || [];
    } catch (error) {
      console.error('Error listing documents:', error);
      throw new Error(`Failed to list documents: ${(error as any).message || error}`);
    }
  }

  /**
   * Get a specific document by ID
   * @param {string} documentId - The document ID
   * @returns {Promise<object>} Document details
   */
  async getDocument(documentId: string) {
    try {
      const document = await (this.ragie as any).documents.get({
        documentId
      });
      
      return document;
    } catch (error) {
      console.error('Error getting document:', error);
      throw new Error(`Failed to get document: ${(error as any).message || error}`);
    }
  }

  /**
   * Test connection to Ragie API
   * @returns {Promise<object>} Test result
   */
  async testConnection() {
    try {
      // Try to list documents as a connection test
      const response = await (this.ragie as any).documents.list({ limit: 1 });
      
      return {
        success: true,
        message: 'Successfully connected to Ragie API',
        details: {
          documentsAvailable: response.documents?.length || 0,
          apiKeyValid: true
        }
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to connect to Ragie API: ${(error as any).message || error}`,
        details: {
          error: (error as any).message || error,
          apiKeyValid: false
        }
      };
    }
  }

  /**
   * Delete a document by ID
   * @param {string} documentId - The document ID to delete
   * @returns {Promise<void>}
   */
  async deleteDocument(documentId: string) {
    try {
      await (this.ragie as any).documents.delete({
        documentId
      });
    } catch (error) {
      console.error('Error deleting document:', error);
      throw new Error(`Failed to delete document: ${(error as any).message || error}`);
    }
  }

  /**
   * Upload a document to Ragie
   * @param {Blob} file - File blob to upload
   * @param {string} name - File name
   * @param {object} metadata - Optional metadata
   * @returns {Promise<object>} Created document
   */
  async uploadDocument(file: Blob, name: string, metadata = {}) {
    try {
      const response = await (this.ragie as any).documents.create({
        file,
        name,
        metadata
      });
      
      return response;
    } catch (error) {
      console.error('Error uploading document:', error);
      throw new Error(`Failed to upload document: ${(error as any).message || error}`);
    }
  }

  /**
   * Debug method to get raw API response
   * @param {string} query - The search query
   * @param {number} topK - Number of results to return
   * @returns {Promise<object>} Raw API response
   */
  async debugSearch(query: string, topK: number = 3) {
    try {
      const requestParams = {
        query,
        top_k: topK,
        rerank: true
      };

      const response = await this.ragie.retrievals.retrieve(requestParams);
      
      return {
        requestParams,
        rawResponse: response,
        responseType: typeof response,
        hasScoreChunks: !!(response as any).scoredChunks,
        chunkCount: (response as any).scoredChunks?.length || 0
      };
    } catch (error) {
      console.error('Error in debug search:', error);
      throw new Error(`Failed to debug search: ${(error as any).message || error}`);
    }
  }
}