import axios from "axios";
import dotenv from "dotenv";
import type { AxiosResponse } from "axios";
import fs from "fs";
import crypto from "crypto";
import path from "path";
import { RagieService } from './ragieService';

// Load environment variables from the project root, regardless of working directory
const projectRoot = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(projectRoot, '.env') });

const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
const BASE_ID = "appMXDULPdtP3RsYT";
const RAGIE_API_KEY = process.env.RAGIE_API_KEY || "tnt_JdgN2vTLRVd_uyxjbRI6iWJYttXGYX9vOsWdSDgOuWloz3MtgcNbvOJ";

// ✅ Tables to export
const TABLES = [
  { name: "Funds [Master]", file: "funds" },
  { name: "Allocators [Master]", file: "allocators" },
];

interface TableConfig {
  name: string;
  file: string;
}

interface HashData {
  [key: string]: string;
}

class AirtableService {
  private ragieService: RagieService;
  private hashFilePath: string;

  constructor() {
    // Validate required environment variables
    if (!AIRTABLE_PAT) {
      const envPath = path.join(path.resolve(__dirname, '..'), '.env');
      const envExists = fs.existsSync(envPath);
      
      console.error('❌ AIRTABLE_PAT environment variable is required!');
      console.error(`Working directory: ${process.cwd()}`);
      console.error(`Looking for .env file at: ${envPath}`);
      console.error(`Environment file exists: ${envExists}`);
      console.error('Please create a .env file with your Airtable Personal Access Token:');
      console.error('AIRTABLE_PAT=your_token_here');
      
      throw new Error('AIRTABLE_PAT environment variable is required. Check console for details.');
    }
    
    this.ragieService = new RagieService(RAGIE_API_KEY);
    this.hashFilePath = path.join(process.cwd(), 'data_hashes.json');
  }

  /**
   * Generate MD5 hash for data
   */
  private generateHash(data: any): string {
    return crypto.createHash('md5').update(JSON.stringify(data)).digest('hex');
  }

  /**
   * Load existing hashes from file
   */
  private loadHashes(): HashData {
    try {
      if (fs.existsSync(this.hashFilePath)) {
        const hashData = fs.readFileSync(this.hashFilePath, 'utf8');
        return JSON.parse(hashData);
      }
    } catch (error) {
      console.error('Error loading hashes:', error);
    }
    return {};
  }

  /**
   * Save hashes to file
   */
  private saveHashes(hashes: HashData): void {
    try {
      fs.writeFileSync(this.hashFilePath, JSON.stringify(hashes, null, 2));
    } catch (error) {
      console.error('Error saving hashes:', error);
    }
  }

  /**
   * Fetch data from a specific Airtable table
   */
  async fetchTable(tableName: string, fileName: string): Promise<any[]> {
    let allRecords: any[] = [];
    let offset: string | undefined = undefined;

    console.error(`\n⏳ Fetching records from table: ${tableName}...`);

    try {
      do {
        const url = `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(tableName)}`;
        const response: AxiosResponse<any> = await axios.get(url, {
          headers: {
            Authorization: `Bearer ${AIRTABLE_PAT}`,
          },
          params: { 
            pageSize: 100, 
            offset 
          },
        });

        allRecords = [...allRecords, ...response.data.records];
        offset = response.data.offset;

      } while (offset);

      console.error(`✅ Retrieved ${allRecords.length} records from "${tableName}".`);
      return allRecords;

    } catch (err: any) {
      console.error(`❌ Error fetching table "${tableName}":`);
      console.error(err.response?.data || err.message);
      throw err;
    }
  }

  /**
   * Save data to files (JSON and TXT)
   */
  private saveDataToFiles(data: any[], fileName: string): void {
    // Write JSON
    const jsonPath = `airtable_${fileName}.json`;
    fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));

    // Write readable TXT
    const readable = data
      .map((rec, index) => `#${index + 1}\nID: ${rec.id}\n${JSON.stringify(rec.fields, null, 2)}\n`)
      .join("\n");

    const txtPath = `airtable_${fileName}.txt`;
    fs.writeFileSync(txtPath, readable);

    console.error(`📁 Saved -> ${jsonPath} and ${txtPath}`);
  }

  /**
   * Delete existing Ragie documents for a specific table
   */
  private async deleteExistingRagieDocuments(tableName: string): Promise<void> {
    try {
      console.error(`🔍 Checking for existing documents for ${tableName}...`);
      
      // Use the filter format that works (simple metadata filter)
      const filter = JSON.stringify({ "table_name": tableName });
      console.error(`   Filter: ${filter}`);
      
      const documents = await this.ragieService.listDocuments(filter as any);
      
      if (documents.length === 0) {
        console.error(`✅ No existing documents found for ${tableName}`);
        return;
      }
      
      console.error(`🗑️  Found ${documents.length} existing document(s) for ${tableName}, deleting...`);
      
      // Delete all found documents
      for (const doc of documents) {
        await this.ragieService.deleteDocument(doc.id);
        console.error(`   ✓ Deleted document: ${doc.id} (${doc.name})`);
      }
      
      console.error(`✅ Successfully deleted ${documents.length} old document(s)`);
    } catch (error) {
      console.error(`⚠️  Warning: Could not delete existing documents:`, error);
      // Don't throw - we'll proceed with upload even if deletion fails
    }
  }

  /**
   * Upload data to Ragie as a document
   */
  private async uploadToRagie(data: any[], fileName: string, tableName: string): Promise<void> {
    try {
      // First, delete any existing documents for this table
      await this.deleteExistingRagieDocuments(tableName);
      
      // Create a formatted text content for Ragie
      const content = data
        .map((record, index) => {
          const fields = Object.entries(record.fields)
            .map(([key, value]) => `${key}: ${value}`)
            .join('\n');
          
          return `Record ${index + 1} (ID: ${record.id})\n${fields}\n`;
        })
        .join('\n---\n\n');

      // Create a blob from the content
      const blob = new Blob([content], { type: 'text/plain' });

      // Upload to Ragie with metadata
      const response = await this.ragieService.uploadDocument(
        blob,
        `airtable_${fileName}.txt`,
        {
          title: `${tableName} - Airtable Data`,
          source: 'Airtable',
          table_name: tableName,
          export_type: 'Airtable Export',
          scope: 'side_letter_knowledge_base',
          last_updated: new Date().toISOString(),
          record_count: data.length
        }
      );

      console.error(`📤 Uploaded ${fileName} to Ragie:`, response);
    } catch (error) {
      console.error(`❌ Error uploading ${fileName} to Ragie:`, error);
      throw error;
    }
  }

  /**
   * Check if data has changed by comparing hashes
   */
  private hasDataChanged(data: any[], fileName: string, existingHashes: HashData): boolean {
    const newHash = this.generateHash(data);
    const existingHash = existingHashes[fileName];
    
    if (!existingHash || existingHash !== newHash) {
      console.error(`🔄 Data changed for ${fileName} (Hash: ${existingHash} -> ${newHash})`);
      return true;
    }
    
    console.error(`✅ No changes detected for ${fileName} (Hash: ${newHash})`);
    return false;
  }

  /**
   * Process a single table: fetch, check for changes, save if needed, upload to Ragie
   */
  async processTable(tableConfig: TableConfig, existingHashes: HashData): Promise<{ updated: boolean; hash: string }> {
    try {
      // Fetch data from Airtable
      const data = await this.fetchTable(tableConfig.name, tableConfig.file);
      
      // Check if data has changed
      const hasChanged = this.hasDataChanged(data, tableConfig.file, existingHashes);
      
      if (hasChanged) {
        // Save to files
        this.saveDataToFiles(data, tableConfig.file);
        
        // Upload to Ragie (this will delete old documents first)
        await this.uploadToRagie(data, tableConfig.file, tableConfig.name);
        
        return {
          updated: true,
          hash: this.generateHash(data)
        };
      }
      
      return {
        updated: false,
        hash: existingHashes[tableConfig.file]
      };
      
    } catch (error) {
      console.error(`❌ Error processing table ${tableConfig.name}:`, error);
      throw error;
    }
  }

  /**
   * Main function to sync all tables
   */
  async syncTables(): Promise<void> {
    console.error('Starting Airtable sync process...');
    
    try {
      // Load existing hashes
      const existingHashes = this.loadHashes();
      const newHashes: HashData = { ...existingHashes };
      
      let totalUpdated = 0;
      
      // Process each table
      for (const table of TABLES) {
        console.error(`\n📋 Processing table: ${table.name}`);
        
        const result = await this.processTable(table, existingHashes);
        
        if (result.updated) {
          newHashes[table.file] = result.hash;
          totalUpdated++;
        }
      }
      
      // Save updated hashes
      if (totalUpdated > 0) {
        this.saveHashes(newHashes);
        console.error(`\n✅ Sync completed! ${totalUpdated} table(s) updated.`);
      } else {
        console.error('\n✅ Sync completed! No changes detected.');
      }
      
    } catch (error) {
      console.error('❌ Sync process failed:', error);
      throw error;
    }
  }

  /**
   * Test connection to both Airtable and Ragie
   */
  async testConnections(): Promise<void> {
    console.error('🔍 Testing connections...');
    
    try {
      // Test Airtable connection
      console.error('Testing Airtable connection...');
      const testUrl = `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(TABLES[0].name)}`;
      await axios.get(testUrl, {
        headers: {
          Authorization: `Bearer ${AIRTABLE_PAT}`,
        },
        params: { pageSize: 1 }
      });
      console.error('✅ Airtable connection successful');
      
      // Test Ragie connection
      console.error('Testing Ragie connection...');
      const ragieTest = await this.ragieService.testConnection();
      if (ragieTest.success) {
        console.error('✅ Ragie connection successful');
      } else {
        console.error('❌ Ragie connection failed:', ragieTest.message);
      }
      
    } catch (error) {
      console.error('❌ Connection test failed:', error);
      throw error;
    }
  }

  /**
   * Force refresh all data (ignore hashes)
   */
  async forceRefresh(): Promise<void> {
    console.error('🔄 Force refreshing all data...');
    
    try {
      const newHashes: HashData = {};
      
      for (const table of TABLES) {
        console.error(`\n📋 Force processing table: ${table.name}`);
        
        // Fetch data
        const data = await this.fetchTable(table.name, table.file);
        
        // Save to files
        this.saveDataToFiles(data, table.file);
        
        // Upload to Ragie (this will delete old documents first)
        await this.uploadToRagie(data, table.file, table.name);
        
        // Store new hash
        newHashes[table.file] = this.generateHash(data);
      }
      
      // Save hashes
      this.saveHashes(newHashes);
      
      console.error('\n✅ Force refresh completed!');
      
    } catch (error) {
      console.error('❌ Force refresh failed:', error);
      throw error;
    }
  }

  /**
   * Clean up duplicate documents in Ragie (utility function)
   */
  async cleanupDuplicates(): Promise<void> {
    console.error('🧹 Cleaning up duplicate documents in Ragie...');
    
    try {
      for (const table of TABLES) {
        console.error(`\n📋 Checking ${table.name} for duplicates...`);
        
        // Use simple filter that works
        const filter = JSON.stringify({ "table_name": table.name });
        
        const documents = await this.ragieService.listDocuments(filter as any);
        
        if (documents.length === 0) {
          console.error(`   ✅ No documents found for ${table.name}`);
          continue;
        }
        
        if (documents.length === 1) {
          console.error(`   ✅ Only one document found for ${table.name} (no duplicates)`);
          continue;
        }
        
        console.error(`   🗑️  Found ${documents.length} documents for ${table.name}, keeping newest...`);
        
        // Sort by upload date and keep the newest
        const sorted = documents.sort((a: any, b: any) => {
          const dateA = new Date(a.updatedAt || a.createdAt).getTime();
          const dateB = new Date(b.updatedAt || b.createdAt).getTime();
          return dateB - dateA; // Newest first
        });
        
        const toKeep = sorted[0];
        const toDelete = sorted.slice(1);
        
        console.error(`   ✓ Keeping: ${toKeep.id} (updated: ${toKeep.updatedAt || toKeep.createdAt})`);
        
        for (const doc of toDelete) {
          await this.ragieService.deleteDocument(doc.id);
          console.error(`   ✓ Deleted: ${doc.id} (updated: ${doc.updatedAt || doc.createdAt})`);
        }
        
        console.error(`   ✅ Deleted ${toDelete.length} duplicate(s) for ${table.name}`);
      }
      
      console.error('\n✅ Cleanup completed!');
      
    } catch (error) {
      console.error('❌ Cleanup failed:', error);
      throw error;
    }
  }
}

// CLI interface
async function main() {
  const airtableService = new AirtableService();
  
  const command = process.argv[2];
  
  try {
    switch (command) {
      case 'sync':
        await airtableService.syncTables();
        break;
      case 'test':
        await airtableService.testConnections();
        break;
      case 'force':
        await airtableService.forceRefresh();
        break;
      case 'cleanup':
        await airtableService.cleanupDuplicates();
        break;
      default:
        console.error(`
Usage: node airtableService.js <command>

Commands:
  sync    - Sync tables (only update if data changed)
  test    - Test connections to Airtable and Ragie
  force   - Force refresh all data (ignore hashes)
  cleanup - Clean up duplicate documents in Ragie

Examples:
  node airtableService.js sync
  node airtableService.js test
  node airtableService.js force
  node airtableService.js cleanup
        `);
    }
  } catch (error) {
    console.error('❌ Command failed:', error);
    process.exit(1);
  }
}

// Export for use as module
export { AirtableService };

// Run if called directly
if (require.main === module) {
  main();
}