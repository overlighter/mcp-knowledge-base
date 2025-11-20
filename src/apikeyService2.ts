import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

interface UserToken {
  token: string;
  email: string;
  createdAt: string;
  lastUsed?: string;
  isActive: boolean;
}

interface TokenStorage {
  userTokens: UserToken[];
  adminApiKeys: string[]; // Keep consistent with original structure
  lastUpdated: string;
}

export class ApiKeyService2 {
  private tokensFilePath: string;

  constructor() {
    // Path to the tokens file in the project root
    this.tokensFilePath = path.resolve(__dirname, '..', 'user-tokens.json');
  }

  /**
   * Load tokens from the JSON file
   */
  private loadTokens(): TokenStorage {
    try {
      if (!fs.existsSync(this.tokensFilePath)) {
        // Create default file if it doesn't exist
        const defaultTokens: TokenStorage = {
          userTokens: [],
          adminApiKeys: [],
          lastUpdated: new Date().toISOString()
        };
        this.saveTokens(defaultTokens);
        return defaultTokens;
      }

      const fileContent = fs.readFileSync(this.tokensFilePath, 'utf-8');
      return JSON.parse(fileContent);
    } catch (error) {
      console.error('Error loading tokens:', error);
      throw new Error('Failed to load tokens');
    }
  }

  /**
   * Save tokens to the JSON file
   */
  private saveTokens(tokens: TokenStorage): void {
    try {
      tokens.lastUpdated = new Date().toISOString();
      fs.writeFileSync(this.tokensFilePath, JSON.stringify(tokens, null, 2));
    } catch (error) {
      console.error('Error saving tokens:', error);
      throw new Error('Failed to save tokens');
    }
  }

  /**
   * Generate a unique token
   */
  private generateToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Validate token and email combination
   */
  validateTokenAndEmail(token: string, email: string): { 
    isValid: boolean; 
    isAdmin: boolean; 
    userType: 'user' | 'admin' | null;
    message?: string;
  } {
    const tokens = this.loadTokens();
    
    console.log('=== Token Validation Debug ===');
    console.log('Token:', token);
    console.log('Email:', email);
    console.log('================================');

    // Check admin keys first (simple string array, no email binding for admins)
    if (tokens.adminApiKeys.includes(token)) {
      return { 
        isValid: true, 
        isAdmin: true, 
        userType: 'admin',
        message: 'Admin access granted'
      };
    }

    // Check user tokens
    const userToken = tokens.userTokens.find(
      t => t.token === token && t.email === email && t.isActive
    );
    
    if (userToken) {
      // Update last used timestamp
      userToken.lastUsed = new Date().toISOString();
      this.saveTokens(tokens);
      
      return { 
        isValid: true, 
        isAdmin: false, 
        userType: 'user',
        message: 'User access granted'
      };
    }

    return { 
      isValid: false, 
      isAdmin: false, 
      userType: null,
      message: 'Invalid token or email combination'
    };
  }

  /**
   * Create a new user token with email
   */
  createUserToken(email: string, userType: 'user' | 'admin' = 'user'): { 
    success: boolean; 
    token?: string; 
    email?: string;
    accessUrl?: string;
    message: string;
  } {
    try {
      const tokens = this.loadTokens();
      
      // Check if email already has an active token
      const existingToken = tokens.userTokens
        .find(t => t.email === email && t.isActive);
      
      if (existingToken) {
        // Return existing token info
        const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
        const accessUrl = `${baseUrl}/?token=${existingToken.token}&email=${encodeURIComponent(email)}`;
        
        return { 
          success: true, 
          token: existingToken.token,
          email: email,
          accessUrl: accessUrl,
          message: `Active token already exists for ${email}` 
        };
      }
      
      // Generate new token
      const newToken: UserToken = {
        token: this.generateToken(),
        email: email,
        createdAt: new Date().toISOString(),
        lastUsed: new Date().toISOString(),
        isActive: true
      };
      
      if (userType === 'admin') {
        tokens.adminApiKeys.push(newToken.token);
      } else {
        tokens.userTokens.push(newToken);
      }
      
      this.saveTokens(tokens);
      
      // Generate access URL
      const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
      const accessUrl = `${baseUrl}/?token=${newToken.token}&email=${encodeURIComponent(email)}`;
      
      return { 
        success: true, 
        token: newToken.token,
        email: email,
        accessUrl: accessUrl,
        message: `Token created successfully for ${email}` 
      };
    } catch (error) {
      return { 
        success: false, 
        message: `Failed to create token: ${error}` 
      };
    }
  }

  /**
   * Deactivate a token (soft delete)
   */
  deactivateToken(token: string, email: string): { success: boolean; message: string } {
    try {
      const tokens = this.loadTokens();
      
      // Check in user tokens
      const userToken = tokens.userTokens.find(t => t.token === token && t.email === email);
      if (userToken) {
        userToken.isActive = false;
        this.saveTokens(tokens);
        return { success: true, message: 'User token deactivated successfully' };
      }
      
      return { success: false, message: 'Token not found' };
    } catch (error) {
      return { success: false, message: `Failed to deactivate token: ${error}` };
    }
  }

  /**
   * Permanently delete a token
   */
  deleteToken(token: string, email: string): { success: boolean; message: string } {
    try {
      const tokens = this.loadTokens();
      
      // Check in user tokens
      const userIndex = tokens.userTokens.findIndex(t => t.token === token && t.email === email);
      if (userIndex !== -1) {
        tokens.userTokens.splice(userIndex, 1);
        this.saveTokens(tokens);
        return { success: true, message: 'User token deleted successfully' };
      }
      
      return { success: false, message: 'Token not found' };
    } catch (error) {
      return { success: false, message: `Failed to delete token: ${error}` };
    }
  }

  /**
   * Get token info by email
   */
  getTokenByEmail(email: string): { 
    success: boolean; 
    token?: UserToken; 
    userType?: 'user';
    message: string;
  } {
    try {
      const tokens = this.loadTokens();
      
      // Check user tokens only
      const userToken = tokens.userTokens.find(t => t.email === email && t.isActive);
      if (userToken) {
        return { 
          success: true, 
          token: userToken,
          userType: 'user',
          message: 'User token found' 
        };
      }
      
      return { 
        success: false, 
        message: 'No active token found for this email' 
      };
    } catch (error) {
      return { 
        success: false, 
        message: `Failed to get token: ${error}` 
      };
    }
  }

  /**
   * List all tokens (for admin use only)
   */
  listAllTokens(): { 
    userTokens: UserToken[]; 
    adminApiKeys: string[]; 
    totalCount: number;
    activeCount: number;
  } {
    const tokens = this.loadTokens();
    const activeUserTokens = tokens.userTokens.filter(t => t.isActive);
    
    return {
      userTokens: tokens.userTokens,
      adminApiKeys: tokens.adminApiKeys,
      totalCount: tokens.userTokens.length + tokens.adminApiKeys.length,
      activeCount: activeUserTokens.length + tokens.adminApiKeys.length
    };
  }

  /**
   * Get statistics about tokens
   */
  getStats(): { 
    userCount: number; 
    adminCount: number; 
    activeUserCount: number;
    lastUpdated: string;
  } {
    const tokens = this.loadTokens();
    const activeUserTokens = tokens.userTokens.filter(t => t.isActive);
    
    return {
      userCount: tokens.userTokens.length,
      adminCount: tokens.adminApiKeys.length,
      activeUserCount: activeUserTokens.length,
      lastUpdated: tokens.lastUpdated
    };
  }

  /**
   * Generate access URL for existing token
   */
  generateAccessUrl(email: string): { 
    success: boolean; 
    accessUrl?: string; 
    message: string;
  } {
    try {
      const result = this.getTokenByEmail(email);
      
      if (!result.success || !result.token) {
        return { 
          success: false, 
          message: 'No active token found for this email' 
        };
      }
      
      const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
      const accessUrl = `${baseUrl}/?token=${result.token.token}&email=${encodeURIComponent(email)}`;
      
      return { 
        success: true, 
        accessUrl: accessUrl,
        message: 'Access URL generated successfully' 
      };
    } catch (error) {
      return { 
        success: false, 
        message: `Failed to generate URL: ${error}` 
      };
    }
  }

  /**
   * Check if a token is an admin key
   */
  isAdminKey(token: string): boolean {
    const tokens = this.loadTokens();
    return tokens.adminApiKeys.includes(token);
  }
}