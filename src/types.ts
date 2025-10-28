// Type definitions for the MCP Knowledge Base server

export interface RagieSearchResult {
  id: string;
  score: number;
  text: string;
  metadata: {
    document_id: string;
    document_name: string;
    page_number?: number;
    chunk_id: string;
    source?: string;
  };
}

export interface RagieSearchResponse {
  scored_chunks: Array<{
    text: string;
    score: number;
    document_id: string;
    document_metadata: {
      document_id: string;
      document_type: string;
      document_source: string;
      document_name: string;
      document_uploaded_at: number;
      title: string;
    };
  }>;
}

export interface Citation {
  source: string;
  page?: number;
  document_id: string;
  text_snippet: string;
}

export interface SearchResponse {
  results: Array<{
    content: string;
    score: number;
    citation: Citation;
  }>;
  query: string;
  total_results: number;
}

export interface AirtableRecord {
  id: string;
  fields: Record<string, any>;
  createdTime: string;
}

export interface User {
  id: string;
  email: string;
  apiKey?: string;
  role: 'admin' | 'user';
}

export interface AuthContext {
  user: User;
  token: string;
}