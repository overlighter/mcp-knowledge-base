import fs from 'fs';
import path from 'path';

interface Fund {
  id: string;
  createdTime: string;
  fields: {
    "Fund Name"?: string;
    "GP Name"?: string;
    "GP Linkedin"?: string;
    "Fund Number"?: string;
    "Fund Size"?: number;
    "Why Interesting?"?: string;
    "Submission Date"?: string;
    "Visibility"?: string[];
    "Keywords"?: string[];
    "Fundraising Status"?: string;
    "Fund Website"?: string;
    "Co-Investors"?: string[];
    "Briefings"?: string[];
    [key: string]: any;
  };
}

interface Allocator {
  id: string;
  createdTime: string;
  fields: {
    "Investor Name"?: string;
    "Investor Type"?: string;
    "LP Keywords"?: string[];
    "Website"?: string;
    "Title"?: string;
    "City"?: string;
    "Country"?: string;
    "Gender"?: string;
    "Entity Name"?: string;
    "Linkedin URL"?: string;
    "Podcast Name"?: string[];
    "Investor Thesis"?: string;
    [key: string]: any;
  };
}

export class LocalDataService {
  private fundsFilePath: string;
  private allocatorsFilePath: string;

  constructor() {
    // Use absolute paths to the JSON files
    const projectRoot = path.resolve(__dirname, '..');
    this.fundsFilePath = path.join(projectRoot, 'airtable_funds.json');
    this.allocatorsFilePath = path.join(projectRoot, 'airtable_allocators.json');
  }

  /**
   * Load funds data from JSON file
   */
  private loadFunds(): Fund[] {
    try {
      if (!fs.existsSync(this.fundsFilePath)) {
        throw new Error(`Funds file not found at: ${this.fundsFilePath}`);
      }
      
      const data = fs.readFileSync(this.fundsFilePath, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      console.error('Error loading funds data:', error);
      throw new Error(`Failed to load funds data: ${error}`);
    }
  }

  /**
   * Load allocators data from JSON file
   */
  private loadAllocators(): Allocator[] {
    try {
      if (!fs.existsSync(this.allocatorsFilePath)) {
        throw new Error(`Allocators file not found at: ${this.allocatorsFilePath}`);
      }
      
      const data = fs.readFileSync(this.allocatorsFilePath, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      console.error('Error loading allocators data:', error);
      throw new Error(`Failed to load allocators data: ${error}`);
    }
  }

  /**
   * Get all funds data
   */
  getAllFunds(): Fund[] {
    return this.loadFunds();
  }

  /**
   * Get all allocators data
   */
  getAllAllocators(): Allocator[] {
    return this.loadAllocators();
  }

  /**
   * Search funds with flexible filtering
   */
  searchFunds(filters: {
    fundName?: string;
    gpName?: string;
    coInvestors?: string;
    fundraisingStatus?: string;
    keywords?: string;
    fundNumber?: string;
    visibility?: string;
  }): Fund[] {
    const funds = this.loadFunds();
    
    return funds.filter(fund => {
      const fields = fund.fields;
      
      // Fund name filter (case-insensitive partial match)
      if (filters.fundName) {
        const fundName = fields["Fund Name"]?.toLowerCase() || '';
        if (!fundName.includes(filters.fundName.toLowerCase())) {
          return false;
        }
      }
      
      // GP name filter (case-insensitive partial match)
      if (filters.gpName) {
        const gpName = fields["GP Name"]?.toLowerCase() || '';
        if (!gpName.includes(filters.gpName.toLowerCase())) {
          return false;
        }
      }
      
      // Co-investors filter (check if any co-investor matches)
      if (filters.coInvestors) {
        const coInvestors = fields["Co-Investors"] || [];
        const hasMatch = coInvestors.some(investor => 
          investor.toLowerCase().includes(filters.coInvestors!.toLowerCase())
        );
        if (!hasMatch) {
          return false;
        }
      }
      
      // Fundraising status filter (exact match)
      if (filters.fundraisingStatus) {
        const status = fields["Fundraising Status"]?.toLowerCase() || '';
        if (status !== filters.fundraisingStatus.toLowerCase()) {
          return false;
        }
      }
      
      // Keywords filter (check if any keyword matches)
      if (filters.keywords) {
        const keywords = fields["Keywords"] || [];
        const hasMatch = keywords.some(keyword => 
          keyword.toLowerCase().includes(filters.keywords!.toLowerCase())
        );
        if (!hasMatch) {
          return false;
        }
      }
      
      // Fund number filter (exact match)
      if (filters.fundNumber) {
        const fundNumber = fields["Fund Number"]?.toLowerCase() || '';
        if (fundNumber !== filters.fundNumber.toLowerCase()) {
          return false;
        }
      }
      
      // Visibility filter (check if any visibility matches)
      if (filters.visibility) {
        const visibility = fields["Visibility"] || [];
        const hasMatch = visibility.some(vis => 
          vis.toLowerCase().includes(filters.visibility!.toLowerCase())
        );
        if (!hasMatch) {
          return false;
        }
      }
      
      return true;
    });
  }

  /**
   * Search allocators with flexible filtering
   */
  searchAllocators(filters: {
    investorName?: string;
    investorType?: string;
    entityName?: string;
    city?: string;
    country?: string;
    gender?: string;
    lpKeywords?: string;
  }): Allocator[] {
    const allocators = this.loadAllocators();
    
    return allocators.filter(allocator => {
      const fields = allocator.fields;
      
      // Investor name filter (case-insensitive partial match)
      if (filters.investorName) {
        const investorName = fields["Investor Name"]?.toLowerCase() || '';
        if (!investorName.includes(filters.investorName.toLowerCase())) {
          return false;
        }
      }
      
      // Investor type filter (case-insensitive partial match)
      if (filters.investorType) {
        const investorType = fields["Investor Type"]?.toLowerCase() || '';
        if (!investorType.includes(filters.investorType.toLowerCase())) {
          return false;
        }
      }
      
      // Entity name filter (case-insensitive partial match)
      if (filters.entityName) {
        const entityName = fields["Entity Name"]?.toLowerCase() || '';
        if (!entityName.includes(filters.entityName.toLowerCase())) {
          return false;
        }
      }
      
      // City filter (case-insensitive partial match)
      if (filters.city) {
        const city = fields["City"]?.toLowerCase() || '';
        if (!city.includes(filters.city.toLowerCase())) {
          return false;
        }
      }
      
      // Country filter (case-insensitive partial match)
      if (filters.country) {
        const country = fields["Country"]?.toLowerCase() || '';
        if (!country.includes(filters.country.toLowerCase())) {
          return false;
        }
      }
      
      // Gender filter (exact match)
      if (filters.gender) {
        const gender = fields["Gender"]?.toLowerCase() || '';
        if (gender !== filters.gender.toLowerCase()) {
          return false;
        }
      }
      
      // LP Keywords filter (check if any keyword matches)
      if (filters.lpKeywords) {
        const lpKeywords = fields["LP Keywords"] || [];
        const hasMatch = lpKeywords.some(keyword => 
          keyword.toLowerCase().includes(filters.lpKeywords!.toLowerCase())
        );
        if (!hasMatch) {
          return false;
        }
      }
      
      return true;
    });
  }

  /**
   * Get fund by exact ID
   */
  getFundById(id: string): Fund | null {
    const funds = this.loadFunds();
    return funds.find(fund => fund.id === id) || null;
  }

  /**
   * Get allocator by exact ID
   */
  getAllocatorById(id: string): Allocator | null {
    const allocators = this.loadAllocators();
    return allocators.find(allocator => allocator.id === id) || null;
  }

  /**
   * Get summary statistics
   */
  getStatistics(): {
    funds: {
      total: number;
      byStatus: Record<string, number>;
      byFundNumber: Record<string, number>;
    };
    allocators: {
      total: number;
      byType: Record<string, number>;
      byCountry: Record<string, number>;
      byGender: Record<string, number>;
    };
  } {
    const funds = this.loadFunds();
    const allocators = this.loadAllocators();
    
    // Fund statistics
    const fundsByStatus: Record<string, number> = {};
    const fundsByNumber: Record<string, number> = {};
    
    funds.forEach(fund => {
      const status = fund.fields["Fundraising Status"] || 'Unknown';
      fundsByStatus[status] = (fundsByStatus[status] || 0) + 1;
      
      const number = fund.fields["Fund Number"] || 'Unknown';
      fundsByNumber[number] = (fundsByNumber[number] || 0) + 1;
    });
    
    // Allocator statistics
    const allocatorsByType: Record<string, number> = {};
    const allocatorsByCountry: Record<string, number> = {};
    const allocatorsByGender: Record<string, number> = {};
    
    allocators.forEach(allocator => {
      const type = allocator.fields["Investor Type"] || 'Unknown';
      allocatorsByType[type] = (allocatorsByType[type] || 0) + 1;
      
      const country = allocator.fields["Country"] || 'Unknown';
      allocatorsByCountry[country] = (allocatorsByCountry[country] || 0) + 1;
      
      const gender = allocator.fields["Gender"] || 'Unknown';
      allocatorsByGender[gender] = (allocatorsByGender[gender] || 0) + 1;
    });
    
    return {
      funds: {
        total: funds.length,
        byStatus: fundsByStatus,
        byFundNumber: fundsByNumber
      },
      allocators: {
        total: allocators.length,
        byType: allocatorsByType,
        byCountry: allocatorsByCountry,
        byGender: allocatorsByGender
      }
    };
  }

  /**
   * Format results for display
   */
  formatFunds(funds: Fund[], limit?: number): string {
    const fundsToShow = limit ? funds.slice(0, limit) : funds;
    
    return fundsToShow.map((fund, index) => {
      const fields = fund.fields;
      let result = `**${index + 1}. ${fields["Fund Name"] || 'Unnamed Fund'}**\n`;
      result += `ID: ${fund.id}\n`;
      
      if (fields["GP Name"]) result += `GP: ${fields["GP Name"]}\n`;
      if (fields["Fund Number"]) result += `Fund: ${fields["Fund Number"]}\n`;
      if (fields["Fund Size"]) result += `Size: $${(fields["Fund Size"] / 1000000).toFixed(1)}M\n`;
      if (fields["Fundraising Status"]) result += `Status: ${fields["Fundraising Status"]}\n`;
      if (fields["Co-Investors"]) result += `Co-Investors: ${fields["Co-Investors"].join(', ')}\n`;
      if (fields["Keywords"]) result += `Keywords: ${fields["Keywords"].join(', ')}\n`;
      if (fields["Why Interesting?"]) result += `Notes: ${fields["Why Interesting?"]}\n`;
      if (fields["Fund Website"]) result += `Website: ${fields["Fund Website"]}\n`;
      
      return result;
    }).join('\n---\n\n');
  }

  /**
   * Format allocators for display
   */
  formatAllocators(allocators: Allocator[], limit?: number): string {
    const allocatorsToShow = limit ? allocators.slice(0, limit) : allocators;
    
    return allocatorsToShow.map((allocator, index) => {
      const fields = allocator.fields;
      let result = `**${index + 1}. ${fields["Investor Name"] || 'Unnamed Investor'}**\n`;
      result += `ID: ${allocator.id}\n`;
      
      if (fields["Entity Name"]) result += `Entity: ${fields["Entity Name"]}\n`;
      if (fields["Investor Type"]) result += `Type: ${fields["Investor Type"]}\n`;
      if (fields["Title"]) result += `Title: ${fields["Title"]}\n`;
      if (fields["City"]) result += `Location: ${fields["City"]}${fields["Country"] ? `, ${fields["Country"]}` : ''}\n`;
      if (fields["Gender"]) result += `Gender: ${fields["Gender"]}\n`;
      if (fields["LP Keywords"]) result += `Keywords: ${fields["LP Keywords"].join(', ')}\n`;
      if (fields["Website"]) result += `Website: ${fields["Website"]}\n`;
      if (fields["Linkedin URL"]) result += `LinkedIn: ${fields["Linkedin URL"]}\n`;
      if (fields["Investor Thesis"]) {
        const thesis = fields["Investor Thesis"];
        const shortThesis = thesis.length > 200 ? thesis.substring(0, 200) + '...' : thesis;
        result += `Thesis: ${shortThesis}\n`;
      }
      
      return result;
    }).join('\n---\n\n');
  }
}