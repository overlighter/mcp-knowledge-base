import fs from 'fs';
import path from 'path';

interface UserApiKey {
  key: string;
  email: string | null;
  createdAt: string;
  lastUsed?: string;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
}

interface ApiKeyStorage {
  userApiKeys: UserApiKey[];
  adminApiKeys: string[];
  lastUpdated: string;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
}

export class ApiKeyService {
  private apiKeysFilePath: string;

  constructor() {
    this.apiKeysFilePath = path.resolve(__dirname, '..', 'api-keys.json');
  }

  private loadApiKeys(): ApiKeyStorage {
    try {
      if (!fs.existsSync(this.apiKeysFilePath)) {
        const defaultKeys: ApiKeyStorage = {
          userApiKeys: [],
          adminApiKeys: [],
          lastUpdated: new Date().toISOString()
        };
        this.saveApiKeys(defaultKeys);
        return defaultKeys;
      }

      const fileContent = fs.readFileSync(this.apiKeysFilePath, 'utf-8');
      const data = JSON.parse(fileContent);
      
      // Migrate old format to new format if needed
      if (data.userApiKeys && data.userApiKeys.length > 0) {
        if (typeof data.userApiKeys[0] === 'string') {
          data.userApiKeys = data.userApiKeys.map((key: string) => ({
            key,
            email: null,
            createdAt: new Date().toISOString()
          }));
          this.saveApiKeys(data);
        }
      }
      
      return data;
    } catch (error) {
      console.error('Error loading API keys:', error);
      throw new Error('Failed to load API keys');
    }
  }

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
   * Validate API key and optionally bind to email
   */
  validateApiKey(
    apiKey: string, 
    email?: string
  ): { 
    isValid: boolean; 
    isAdmin: boolean; 
    keyType: 'user' | 'admin' | null;
    emailRequired?: boolean;
    emailMismatch?: boolean;
    boundEmail?: string;
  } {
    const apiKeys = this.loadApiKeys();
    const cleanKey = apiKey.replace(/^Bearer\s+/i, '');
    
    console.log('=== API Key Validation ===');
    console.log('Key:', cleanKey.substring(0, 20) + '...');
    console.log('Email provided:', email || 'none');
    
    // Check admin keys first (no email binding for admins)
    if (apiKeys.adminApiKeys.includes(cleanKey)) {
      console.log('✓ Admin key validated');
      return { isValid: true, isAdmin: true, keyType: 'admin' };
    }
    
    // Check user keys with email binding
    const userKeyEntry = apiKeys.userApiKeys.find(k => k.key === cleanKey);
    
    if (userKeyEntry) {
      // Key exists - check email binding
      if (userKeyEntry.email === null) {
        // Key not yet bound to any email
        if (email) {
          // Bind this key to the provided email
          userKeyEntry.email = email;
          userKeyEntry.lastUsed = new Date().toISOString();
          this.saveApiKeys(apiKeys);
          console.log('✓ User key validated and bound to email:', email);
          return { isValid: true, isAdmin: false, keyType: 'user', boundEmail: email };
        } else {
          // Email is required for first-time use
          console.log('❌ Email required for first-time key use');
          return { isValid: false, isAdmin: false, keyType: null, emailRequired: true };
        }
      } else {
        // Key already bound to an email
        if (email && email.toLowerCase() !== userKeyEntry.email.toLowerCase()) {
          // Email mismatch - reject
          console.log('❌ Email mismatch. Key bound to:', userKeyEntry.email);
          return { 
            isValid: false, 
            isAdmin: false, 
            keyType: null, 
            emailMismatch: true,
            boundEmail: userKeyEntry.email
          };
        }
        // Email matches or no email provided (already validated once)
        userKeyEntry.lastUsed = new Date().toISOString();
        this.saveApiKeys(apiKeys);
        console.log('✓ User key validated for email:', userKeyEntry.email);
        return { isValid: true, isAdmin: false, keyType: 'user', boundEmail: userKeyEntry.email };
      }
    }
    
    console.log('❌ Invalid key');
    return { isValid: false, isAdmin: false, keyType: null };
  }

  /**
   * Add a new user API key (admin only)
   */
  addUserApiKey(newKey: string, email: string | null = null): { success: boolean; message: string } {
    try {
      const apiKeys = this.loadApiKeys();
      
      // Check if key already exists
      if (apiKeys.userApiKeys.some(k => k.key === newKey)) {
        return { success: false, message: 'API key already exists' };
      }
      
      if (apiKeys.adminApiKeys.includes(newKey)) {
        return { success: false, message: 'This key is already an admin key' };
      }
      
      apiKeys.userApiKeys.push({
        key: newKey,
        email: email,
        createdAt: new Date().toISOString()
      });
      
      this.saveApiKeys(apiKeys);
      return { success: true, message: 'User API key added successfully' };
    } catch (error) {
      return { success: false, message: `Failed to add API key: ${error}` };
    }
  }

  /**
   * Remove a user API key (admin only)
   */
  // removeUserApiKey(keyToRemove: string): { success: boolean; message: string } {
  //   try {
  //     const apiKeys = this.loadApiKeys();
  //     const index = apiKeys.userApiKeys.findIndex(k => k.key === keyToRemove);
      
  //     if (index === -1) {
  //       return { success: false, message: 'API key not found' };
  //     }
      
  //     const removed = apiKeys.userApiKeys.splice(index, 1)[0];
  //     this.saveApiKeys(apiKeys);
      
  //     return { 
  //       success: true, 
  //       message: `API key removed (was bound to: ${removed.email || 'no email'})` 
  //     };
  //   } catch (error) {
  //     return { success: false, message: `Failed to remove API key: ${error}` };
  //   }
  // }

  /**
   * List all user API keys with their details (admin only)
   */
  listUserApiKeys(): UserApiKey[] {
    const apiKeys = this.loadApiKeys();
    return apiKeys.userApiKeys;
  }

  /**
   * Get statistics about API keys
   */
  getStats(): { 
    userCount: number; 
    adminCount: number; 
    boundKeys: number;
    unboundKeys: number;
    lastUpdated: string;
  } {
    const apiKeys = this.loadApiKeys();
    const boundKeys = apiKeys.userApiKeys.filter(k => k.email !== null).length;
    const unboundKeys = apiKeys.userApiKeys.filter(k => k.email === null).length;
    
    return {
      userCount: apiKeys.userApiKeys.length,
      adminCount: apiKeys.adminApiKeys.length,
      boundKeys,
      unboundKeys,
      lastUpdated: apiKeys.lastUpdated
    };
  }

  /**
   * Check if the provided key is an admin key
   */
  isAdminKey(apiKey: string): boolean {
    const apiKeys = this.loadApiKeys();
    const cleanKey = apiKey.replace(/^Bearer\s+/i, '');
    return apiKeys.adminApiKeys.includes(cleanKey);
  }

  /**
   * Persist access/refresh tokens with expirations to the user API key entry
   */
  persistTokensForKey(
    apiKey: string,
    payload: {
      accessToken: string;
      refreshToken: string;
      tokenExpiresAt: number; // ms since epoch
      refreshTokenExpiresAt: number; // ms since epoch
    }
  ): { success: boolean; message: string } {
    try {
      const apiKeys = this.loadApiKeys();
      const cleanKey = apiKey.replace(/^Bearer\s+/i, '');
      const entry = apiKeys.userApiKeys.find(k => k.key === cleanKey);

      if (!entry) {
        return { success: false, message: 'User API key not found' };
      }

      entry.accessToken = payload.accessToken;
      entry.refreshToken = payload.refreshToken;
      entry.tokenExpiresAt = new Date(payload.tokenExpiresAt).toISOString();
      entry.refreshTokenExpiresAt = new Date(payload.refreshTokenExpiresAt).toISOString();
      entry.lastUsed = new Date().toISOString();

      this.saveApiKeys(apiKeys);
      return { success: true, message: 'Tokens persisted' };
    } catch (error) {
      return { success: false, message: `Failed to persist tokens: ${error}` };
    }
  }

  /**
   * Update only the access token (used during refresh)
   */
  updateAccessToken(
    apiKey: string,
    newAccessToken: string,
    tokenExpiresAt: number
  ): { success: boolean; message: string } {
    try {
      const apiKeys = this.loadApiKeys();
      const cleanKey = apiKey.replace(/^Bearer\s+/i, '');
      const entry = apiKeys.userApiKeys.find(k => k.key === cleanKey);

      if (!entry) {
        return { success: false, message: 'User API key not found' };
      }

      entry.accessToken = newAccessToken;
      entry.tokenExpiresAt = new Date(tokenExpiresAt).toISOString();
      entry.lastUsed = new Date().toISOString();

      this.saveApiKeys(apiKeys);
      return { success: true, message: 'Access token updated' };
    } catch (error) {
      return { success: false, message: `Failed to update access token: ${error}` };
    }
  }

  /**
   * Rehydrate persisted tokens into the in-memory map on server startup
   */
  rehydrateTokens(map: Map<string, { api_key: string; created_at: number; expires_at: number }>): void {
    const apiKeys = this.loadApiKeys();
    const now = Date.now();

    for (const user of apiKeys.userApiKeys) {
      if (user.accessToken && user.tokenExpiresAt) {
        const atExpires = Date.parse(user.tokenExpiresAt);
        if (!Number.isNaN(atExpires) && atExpires > now) {
          map.set(user.accessToken, {
            api_key: user.key,
            created_at: Date.parse(user.createdAt) || now,
            expires_at: atExpires
          });
        }
      }
      if (user.refreshToken && user.refreshTokenExpiresAt) {
        const rtExpires = Date.parse(user.refreshTokenExpiresAt);
        if (!Number.isNaN(rtExpires) && rtExpires > now) {
          map.set(user.refreshToken, {
            api_key: user.key,
            created_at: Date.parse(user.createdAt) || now,
            expires_at: rtExpires
          });
        }
      }
    }
  }

  /**
   * Remove a user API key (admin only) and expose removed tokens for cleanup
   */
  removeUserApiKey(keyToRemove: string): {
    success: boolean;
    message: string;
    removedAccessToken?: string;
    removedRefreshToken?: string;
  } {
    try {
      const apiKeys = this.loadApiKeys();
      const index = apiKeys.userApiKeys.findIndex(k => k.key === keyToRemove);

      if (index === -1) {
        return { success: false, message: 'API key not found' };
      }

      const removed = apiKeys.userApiKeys.splice(index, 1)[0];
      this.saveApiKeys(apiKeys);

      return {
        success: true,
        message: `API key removed (was bound to: ${removed.email || 'no email'})`,
        removedAccessToken: removed.accessToken,
        removedRefreshToken: removed.refreshToken
      };
    } catch (error) {
      return { success: false, message: `Failed to remove API key: ${error}` };
    }
  }
}