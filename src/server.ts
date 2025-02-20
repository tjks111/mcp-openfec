#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import axios, { AxiosInstance } from 'axios';
import { z } from 'zod';

// Rate limiting configuration
const RATE_LIMIT = 1000; // requests per hour
const RATE_WINDOW = 3600000; // 1 hour in milliseconds

class RateLimiter {
  private tokens: number;
  private lastRefill: number;

  constructor(private limit: number, private window: number) {
    this.tokens = limit;
    this.lastRefill = Date.now();
  }

  canMakeRequest(): boolean {
    this.refill();
    return this.tokens > 0;
  }

  consumeToken(): void {
    this.tokens--;
  }

  private refill(): void {
    const now = Date.now();
    const timePassed = now - this.lastRefill;
    const tokensToAdd = Math.floor((timePassed / this.window) * this.limit);
    
    if (tokensToAdd > 0) {
      this.tokens = Math.min(this.limit, this.tokens + tokensToAdd);
      this.lastRefill = now;
    }
  }
}

class OpenFECServer {
  private server: Server;
  private axiosInstance: AxiosInstance;
  private rateLimiter: RateLimiter;

  constructor() {
    const apiKey = process.env.OPENFEC_API_KEY;
    if (!apiKey) {
      throw new Error('OPENFEC_API_KEY environment variable is required');
    }

    this.server = new Server(
      {
        name: 'openfec-server',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.axiosInstance = axios.create({
      baseURL: 'https://api.open.fec.gov/v1',
      params: {
        api_key: apiKey,
      },
    });

    this.rateLimiter = new RateLimiter(RATE_LIMIT, RATE_WINDOW);

    this.setupToolHandlers();
    
    // Error handling
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'get_candidate',
          description: 'Get detailed information about a candidate',
          inputSchema: {
            type: 'object',
            properties: {
              candidate_id: {
                type: 'string',
                description: 'FEC candidate ID',
              },
              election_year: {
                type: 'number',
                description: 'Optional: Filter by election year',
              },
            },
            required: ['candidate_id'],
          },
        },
        {
          name: 'get_candidate_financials',
          description: 'Get financial data for a candidate',
          inputSchema: {
            type: 'object',
            properties: {
              candidate_id: {
                type: 'string',
                description: 'FEC candidate ID',
              },
              election_year: {
                type: 'number',
                description: 'Election year to get data for',
              },
            },
            required: ['candidate_id', 'election_year'],
          },
        },
        {
          name: 'search_candidates',
          description: 'Search for candidates by name or other criteria',
          inputSchema: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Candidate name search string',
              },
              state: {
                type: 'string',
                description: 'Optional: Two-letter state code',
              },
              office: {
                type: 'string',
                description: 'Optional: H for House, S for Senate, P for President',
                enum: ['H', 'S', 'P'],
              },
              election_year: {
                type: 'number',
                description: 'Optional: Filter by election year',
              },
            },
            required: ['name'],
          },
        },
        {
          name: 'get_committee',
          description: 'Get detailed information about a committee',
          inputSchema: {
            type: 'object',
            properties: {
              committee_id: {
                type: 'string',
                description: 'FEC committee ID',
              },
            },
            required: ['committee_id'],
          },
        },
        {
          name: 'get_candidate_contributions',
          description: 'Get individual contributions for a candidate',
          inputSchema: {
            type: 'object',
            properties: {
              candidate_id: {
                type: 'string',
                description: 'FEC candidate ID'
              },
              election_year: {
                type: 'number',
                description: 'Election year'
              },
              sort: {
                type: 'string',
                description: 'Optional: Sort by contribution_receipt_amount (desc for highest first)',
                enum: ['desc', 'asc']
              }
            },
            required: ['candidate_id']
          },
        },
        {
          name: 'get_filings',
          description: 'Retrieve official FEC filings with filters',
          inputSchema: {
            type: 'object',
            properties: {
              committee_id: {
                type: 'string',
                description: 'Optional: FEC committee ID'
              },
              candidate_id: {
                type: 'string',
                description: 'Optional: FEC candidate ID'
              },
              form_type: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional: Form types to filter by (e.g., ["F3", "F3P"])'
              },
              min_receipt_date: {
                type: 'string',
                description: 'Optional: Minimum receipt date (YYYY-MM-DD)'
              },
              max_receipt_date: {
                type: 'string',
                description: 'Optional: Maximum receipt date (YYYY-MM-DD)'
              },
              state: {
                type: 'string',
                description: 'Optional: Two-letter state code'
              },
              sort: {
                type: 'string',
                enum: ['asc', 'desc'],
                description: 'Optional: Sort by receipt date'
              }
            }
          }
        },
        {
          name: 'get_independent_expenditures',
          description: 'Get independent expenditures supporting or opposing candidates',
          inputSchema: {
            type: 'object',
            properties: {
              candidate_id: {
                type: 'string',
                description: 'Optional: FEC candidate ID'
              },
              committee_id: {
                type: 'string',
                description: 'Optional: FEC committee ID'
              },
              support_oppose_indicator: {
                type: 'string',
                enum: ['S', 'O'],
                description: 'Optional: S for supporting or O for opposing'
              },
              min_date: {
                type: 'string',
                description: 'Optional: Minimum expenditure date (YYYY-MM-DD)'
              },
              max_date: {
                type: 'string',
                description: 'Optional: Maximum expenditure date (YYYY-MM-DD)'
              },
              min_amount: {
                type: 'number',
                description: 'Optional: Minimum expenditure amount'
              },
              max_amount: {
                type: 'number',
                description: 'Optional: Maximum expenditure amount'
              },
              sort: {
                type: 'string',
                enum: ['asc', 'desc'],
                description: 'Optional: Sort by expenditure amount'
              }
            }
          }
        },
        {
          name: 'get_electioneering',
          description: 'Get electioneering communications',
          inputSchema: {
            type: 'object',
            properties: {
              committee_id: {
                type: 'string',
                description: 'Optional: FEC committee ID'
              },
              candidate_id: {
                type: 'string',
                description: 'Optional: FEC candidate ID'
              },
              min_date: {
                type: 'string',
                description: 'Optional: Minimum disbursement date (YYYY-MM-DD)'
              },
              max_date: {
                type: 'string',
                description: 'Optional: Maximum disbursement date (YYYY-MM-DD)'
              },
              min_amount: {
                type: 'number',
                description: 'Optional: Minimum disbursement amount'
              },
              max_amount: {
                type: 'number',
                description: 'Optional: Maximum disbursement amount'
              },
              sort: {
                type: 'string',
                enum: ['asc', 'desc'],
                description: 'Optional: Sort by disbursement amount'
              }
            }
          }
        },
        {
          name: 'get_party_coordinated_expenditures',
          description: 'Get party coordinated expenditures',
          inputSchema: {
            type: 'object',
            properties: {
              committee_id: {
                type: 'string',
                description: 'Optional: FEC committee ID'
              },
              candidate_id: {
                type: 'string',
                description: 'Optional: FEC candidate ID'
              },
              min_date: {
                type: 'string',
                description: 'Optional: Minimum expenditure date (YYYY-MM-DD)'
              },
              max_date: {
                type: 'string',
                description: 'Optional: Maximum expenditure date (YYYY-MM-DD)'
              },
              min_amount: {
                type: 'number',
                description: 'Optional: Minimum expenditure amount'
              },
              max_amount: {
                type: 'number',
                description: 'Optional: Maximum expenditure amount'
              },
              sort: {
                type: 'string',
                enum: ['asc', 'desc'],
                description: 'Optional: Sort by expenditure amount'
              }
            }
          }
        },
        {
          name: 'get_communication_costs',
          description: 'Get corporate/union communication costs',
          inputSchema: {
            type: 'object',
            properties: {
              committee_id: {
                type: 'string',
                description: 'Optional: FEC committee ID'
              },
              candidate_id: {
                type: 'string',
                description: 'Optional: FEC candidate ID'
              },
              min_date: {
                type: 'string',
                description: 'Optional: Minimum communication date (YYYY-MM-DD)'
              },
              max_date: {
                type: 'string',
                description: 'Optional: Maximum communication date (YYYY-MM-DD)'
              },
              min_amount: {
                type: 'number',
                description: 'Optional: Minimum cost amount'
              },
              max_amount: {
                type: 'number',
                description: 'Optional: Maximum cost amount'
              },
              sort: {
                type: 'string',
                enum: ['asc', 'desc'],
                description: 'Optional: Sort by cost amount'
              }
            }
          }
        },
        {
          name: 'get_audit_cases',
          description: 'Get FEC audit cases and findings',
          inputSchema: {
            type: 'object',
            properties: {
              committee_id: {
                type: 'string',
                description: 'Optional: FEC committee ID'
              },
              audit_id: {
                type: 'string',
                description: 'Optional: Specific audit case ID'
              },
              audit_year: {
                type: 'number',
                description: 'Optional: Year of audit'
              },
              finding_types: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional: Types of findings to filter by'
              }
            }
          }
        },
        {
          name: 'get_bulk_downloads',
          description: 'Get links to bulk data downloads',
          inputSchema: {
            type: 'object',
            properties: {
              data_type: {
                type: 'string',
                enum: ['contributions', 'expenditures', 'filings', 'committees', 'candidates'],
                description: 'Type of bulk data to download'
              },
              election_year: {
                type: 'number',
                description: 'Optional: Election year for the data'
              }
            },
            required: ['data_type']
          }
        }
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (!this.rateLimiter.canMakeRequest()) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          'Rate limit exceeded. Please try again later.'
        );
      }

      try {
        switch (request.params.name) {
          case 'get_candidate':
            return await this.handleGetCandidate(request.params.arguments);
          case 'search_candidates':
            return await this.handleSearchCandidates(request.params.arguments);
          case 'get_committee':
            return await this.handleGetCommittee(request.params.arguments);
          case 'get_candidate_financials':
            return await this.handleGetCandidateFinancials(request.params.arguments);
          case 'get_candidate_contributions':
            return await this.handleGetCandidateContributions(request.params.arguments);
          case 'get_filings':
            return await this.handleGetFilings(request.params.arguments);
          case 'get_independent_expenditures':
            return await this.handleGetIndependentExpenditures(request.params.arguments);
          case 'get_electioneering':
            return await this.handleGetElectioneering(request.params.arguments);
          case 'get_party_coordinated_expenditures':
            return await this.handleGetPartyCoordinatedExpenditures(request.params.arguments);
          case 'get_communication_costs':
            return await this.handleGetCommunicationCosts(request.params.arguments);
          case 'get_audit_cases':
            return await this.handleGetAuditCases(request.params.arguments);
          case 'get_bulk_downloads':
            return await this.handleGetBulkDownloads(request.params.arguments);
          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${request.params.name}`
            );
        }
      } catch (error) {
        if (axios.isAxiosError(error)) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            `OpenFEC API error: ${error.response?.data?.message || error.message}`
          );
        }
        throw error;
      }
    });
  }

  private async handleGetCandidate(args: any) {
    const schema = z.object({
      candidate_id: z.string(),
      election_year: z.number().optional(),
    });

    const { candidate_id, election_year } = schema.parse(args);
    this.rateLimiter.consumeToken();

    const response = await this.axiosInstance.get(`/candidate/${candidate_id}`, {
      params: election_year ? { election_year } : undefined,
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response.data, null, 2),
        },
      ],
    };
  }

  private async handleSearchCandidates(args: any) {
    const schema = z.object({
      name: z.string(),
      state: z.string().optional(),
      office: z.enum(['H', 'S', 'P']).optional(),
      election_year: z.number().optional(),
    });

    const { name, state, office, election_year } = schema.parse(args);
    this.rateLimiter.consumeToken();

    const response = await this.axiosInstance.get('/candidates/search', {
      params: {
        q: name,
        state,
        office,
        election_year,
      },
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response.data, null, 2),
        },
      ],
    };
  }

  private async handleGetCommittee(args: any) {
    const schema = z.object({
      committee_id: z.string(),
    });

    const { committee_id } = schema.parse(args);
    this.rateLimiter.consumeToken();

    const response = await this.axiosInstance.get(`/committee/${committee_id}`);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response.data, null, 2),
        },
      ],
    };
  }

  private async handleGetCandidateFinancials(args: any) {
    const schema = z.object({
      candidate_id: z.string(),
      election_year: z.number(),
    });

    const { candidate_id, election_year } = schema.parse(args);
    this.rateLimiter.consumeToken();

    const response = await this.axiosInstance.get(`/candidate/${candidate_id}/totals`, {
      params: { election_year }
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response.data, null, 2),
        },
      ],
    };
  }

  private async handleGetCandidateContributions(args: any) {
    const schema = z.object({
      candidate_id: z.string(),
      election_year: z.number().optional(),
      sort: z.enum(['desc', 'asc']).optional()
    });

    const { candidate_id, election_year, sort } = schema.parse(args);
    this.rateLimiter.consumeToken();

    const response = await this.axiosInstance.get(`/schedules/schedule_a/`, {
      params: {
        committee_id: await this.getCommitteeId(candidate_id),
        two_year_transaction_period: election_year,
        sort: sort === 'desc' ? '-contribution_receipt_amount' : 'contribution_receipt_amount',
        per_page: 10
      }
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response.data, null, 2),
        },
      ],
    };
  }

  private async getCommitteeId(candidate_id: string): Promise<string> {
    const response = await this.axiosInstance.get(`/candidate/${candidate_id}/committees`, {
      params: {
        designation: 'P'
      }
    });
    
    if (response.data.results && response.data.results.length > 0) {
      return response.data.results[0].committee_id;
    }
    throw new McpError(
      ErrorCode.InvalidRequest,
      'No principal campaign committee found for candidate'
    );
  }

  private async handleGetFilings(args: any) {
    const schema = z.object({
      committee_id: z.string().optional(),
      candidate_id: z.string().optional(),
      form_type: z.array(z.string()).optional(),
      min_receipt_date: z.string().optional(),
      max_receipt_date: z.string().optional(),
      state: z.string().optional(),
      sort: z.enum(['asc', 'desc']).optional()
    });

    const params = schema.parse(args);
    this.rateLimiter.consumeToken();

    const response = await this.axiosInstance.get('/filings', {
      params: {
        ...params,
        sort_hide_null: true,
        sort: params.sort === 'desc' ? '-receipt_date' : 'receipt_date',
        per_page: 20
      }
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response.data, null, 2),
        },
      ],
    };
  }

  private async handleGetIndependentExpenditures(args: any) {
    const schema = z.object({
      candidate_id: z.string().optional(),
      committee_id: z.string().optional(),
      support_oppose_indicator: z.enum(['S', 'O']).optional(),
      min_date: z.string().optional(),
      max_date: z.string().optional(),
      min_amount: z.number().optional(),
      max_amount: z.number().optional(),
      sort: z.enum(['asc', 'desc']).optional()
    });

    const params = schema.parse(args);
    this.rateLimiter.consumeToken();

    const response = await this.axiosInstance.get('/schedules/schedule_e', {
      params: {
        ...params,
        sort_hide_null: true,
        sort: params.sort === 'desc' ? '-expenditure_amount' : 'expenditure_amount',
        per_page: 20
      }
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response.data, null, 2),
        },
      ],
    };
  }

  private async handleGetElectioneering(args: any) {
    const schema = z.object({
      committee_id: z.string().optional(),
      candidate_id: z.string().optional(),
      min_date: z.string().optional(),
      max_date: z.string().optional(),
      min_amount: z.number().optional(),
      max_amount: z.number().optional(),
      sort: z.enum(['asc', 'desc']).optional()
    });

    const params = schema.parse(args);
    this.rateLimiter.consumeToken();

    const response = await this.axiosInstance.get('/electioneering', {
      params: {
        ...params,
        sort_hide_null: true,
        sort: params.sort === 'desc' ? '-disbursement_amount' : 'disbursement_amount',
        per_page: 20
      }
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response.data, null, 2),
        },
      ],
    };
  }

  private async handleGetPartyCoordinatedExpenditures(args: any) {
    const schema = z.object({
      committee_id: z.string().optional(),
      candidate_id: z.string().optional(),
      min_date: z.string().optional(),
      max_date: z.string().optional(),
      min_amount: z.number().optional(),
      max_amount: z.number().optional(),
      sort: z.enum(['asc', 'desc']).optional()
    });

    const params = schema.parse(args);
    this.rateLimiter.consumeToken();

    const response = await this.axiosInstance.get('/schedules/schedule_f', {
      params: {
        ...params,
        sort_hide_null: true,
        sort: params.sort === 'desc' ? '-expenditure_amount' : 'expenditure_amount',
        per_page: 20
      }
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response.data, null, 2),
        },
      ],
    };
  }

  private async handleGetCommunicationCosts(args: any) {
    const schema = z.object({
      committee_id: z.string().optional(),
      candidate_id: z.string().optional(),
      min_date: z.string().optional(),
      max_date: z.string().optional(),
      min_amount: z.number().optional(),
      max_amount: z.number().optional(),
      sort: z.enum(['asc', 'desc']).optional()
    });

    const params = schema.parse(args);
    this.rateLimiter.consumeToken();

    const response = await this.axiosInstance.get('/schedules/schedule_d', {
      params: {
        ...params,
        sort_hide_null: true,
        sort: params.sort === 'desc' ? '-cost' : 'cost',
        per_page: 20
      }
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response.data, null, 2),
        },
      ],
    };
  }

  private async handleGetAuditCases(args: any) {
    const schema = z.object({
      committee_id: z.string().optional(),
      audit_id: z.string().optional(),
      audit_year: z.number().optional(),
      finding_types: z.array(z.string()).optional()
    });

    const params = schema.parse(args);
    this.rateLimiter.consumeToken();

    const response = await this.axiosInstance.get('/audit-cases', {
      params: {
        ...params,
        sort_hide_null: true,
        per_page: 20
      }
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response.data, null, 2),
        },
      ],
    };
  }

  private async handleGetBulkDownloads(args: any) {
    const schema = z.object({
      data_type: z.enum(['contributions', 'expenditures', 'filings', 'committees', 'candidates']),
      election_year: z.number().optional()
    });

    const { data_type, election_year } = schema.parse(args);
    this.rateLimiter.consumeToken();

    const response = await this.axiosInstance.get('/download', {
      params: {
        data_type,
        election_year
      }
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response.data, null, 2),
        },
      ],
    };
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('OpenFEC MCP server running on stdio');
  }
}

const server = new OpenFECServer();
server.run().catch(console.error);
