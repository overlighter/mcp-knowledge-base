import fs from 'fs';
import path from 'path';

interface ApiKeyStorage {
  userApiKeys: string[];
  adminApiKeys: string[];
  lastUpdated: string;
}

export class ApiKeyService {
  private apiKeysFilePath: string;

  constructor() {
    // Path to the API keys file in the project root
    this.apiKeysFilePath = path.resolve(__dirname, '..', 'api-keys.json');
  }

  /**
   * Load API keys from the JSON file
   */
  private loadApiKeys(): ApiKeyStorage {
    try {
      if (!fs.existsSync(this.apiKeysFilePath)) {
        // Create default file if it doesn't exist
        const defaultKeys: ApiKeyStorage = {
          userApiKeys: [],
          adminApiKeys: [],
          lastUpdated: new Date().toISOString()
        };
        this.saveApiKeys(defaultKeys);
        return defaultKeys;
      }

      const fileContent = fs.readFileSync(this.apiKeysFilePath, 'utf-8');
      return JSON.parse(fileContent);
    } catch (error) {
      console.error('Error loading API keys:', error);
      throw new Error('Failed to load API keys');
    }
  }

  /**
   * Save API keys to the JSON file
   */
  private saveApiKeys(apiKeys: ApiKeyStorage): void {
    try {
      apiKeys.lastUpdated = new Date().toISOString();
      fs.writeFileSync(this.apiKeysFilePath, JSON.stringify(apiKeys, null, 2));
    } catch (error) {
      console.error('Error saving API keys:', error);
      throw new Error('Failed to save API keys');
    }
  }

  /**
   * Validate if an API key exists in either user or admin list
   */
  validateApiKey(apiKey: string): { isValid: boolean; isAdmin: boolean; keyType: 'user' | 'admin' | null } {
    const apiKeys = this.loadApiKeys();
    
    // Clean the API key (remove Bearer prefix if present)
    const cleanKey = apiKey.replace(/^Bearer\s+/i, '');
    
    // Debug logging
    console.log('=== API Key Validation Debug ===');
    console.log('Original API Key:', apiKey);
    console.log('Cleaned API Key:', cleanKey);
    console.log('Stored Admin Keys:', apiKeys.adminApiKeys);
    console.log('Stored User Keys:', apiKeys.userApiKeys);
    console.log('Admin key match:', apiKeys.adminApiKeys.includes(cleanKey));
    console.log('User key match:', apiKeys.userApiKeys.includes(cleanKey));
    console.log('================================');
    
    // Check admin keys first
    if (apiKeys.adminApiKeys.includes(cleanKey)) {
      return { isValid: true, isAdmin: true, keyType: 'admin' };
    }
    
    // Check user keys
    if (apiKeys.userApiKeys.includes(cleanKey)) {
      return { isValid: true, isAdmin: false, keyType: 'user' };
    }
    
    return { isValid: false, isAdmin: false, keyType: null };
  }

  /**
   * Add a new API key to the specified list
   */
  addApiKey(newKey: string, keyType: 'user' | 'admin'): { success: boolean; message: string } {
    try {
      const apiKeys = this.loadApiKeys();
      
      // Check if key already exists in either list
      if (apiKeys.userApiKeys.includes(newKey) || apiKeys.adminApiKeys.includes(newKey)) {
        return { success: false, message: 'API key already exists' };
      }
      
      if (keyType === 'admin') {
        apiKeys.adminApiKeys.push(newKey);
      } else {
        apiKeys.userApiKeys.push(newKey);
      }
      
      this.saveApiKeys(apiKeys);
      return { success: true, message: `API key added to ${keyType} whitelist successfully` };
    } catch (error) {
      return { success: false, message: `Failed to add API key: ${error}` };
    }
  }

  /**
   * Remove an API key from the specified list
   */
  removeApiKey(keyToRemove: string, keyType: 'user' | 'admin'): { success: boolean; message: string } {
    try {
      const apiKeys = this.loadApiKeys();
      
      if (keyType === 'admin') {
        const index = apiKeys.adminApiKeys.indexOf(keyToRemove);
        if (index === -1) {
          return { success: false, message: 'API key not found in admin whitelist' };
        }
        apiKeys.adminApiKeys.splice(index, 1);
      } else {
        const index = apiKeys.userApiKeys.indexOf(keyToRemove);
        if (index === -1) {
          return { success: false, message: 'API key not found in user whitelist' };
        }
        apiKeys.userApiKeys.splice(index, 1);
      }
      
      this.saveApiKeys(apiKeys);
      return { success: true, message: `API key removed from ${keyType} whitelist successfully` };
    } catch (error) {
      return { success: false, message: `Failed to remove API key: ${error}` };
    }
  }

  /**
   * List all API keys (for admin use only)
   */
  listApiKeys(): { userKeys: string[]; adminKeys: string[]; totalCount: number } {
    const apiKeys = this.loadApiKeys();
    return {
      userKeys: apiKeys.userApiKeys,
      adminKeys: apiKeys.adminApiKeys,
      totalCount: apiKeys.userApiKeys.length + apiKeys.adminApiKeys.length
    };
  }

  /**
   * Get statistics about API keys
   */
  getStats(): { userCount: number; adminCount: number; lastUpdated: string } {
    const apiKeys = this.loadApiKeys();
    return {
      userCount: apiKeys.userApiKeys.length,
      adminCount: apiKeys.adminApiKeys.length,
      lastUpdated: apiKeys.lastUpdated
    };
  }
}