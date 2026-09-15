// Fallback type declarations for 'pg' in environments where @types/pg may be skipped
declare module 'pg' {
  export interface PoolConfig {
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    password?: string | (() => string | Promise<string>);
    ssl?: boolean | object;
    max?: number;
    idleTimeoutMillis?: number;
    connectionTimeoutMillis?: number;
    application_name?: string;
    [key: string]: any;
  }

  export interface QueryResult<R = any> {
    rows: R[];
    rowCount: number | null;
    command: string;
    oid: number;
    fields: any[];
  }

  export interface PoolClient {
    query(queryTextOrConfig: any, values?: any): Promise<QueryResult>;
    release(err?: Error | boolean): void;
    [key: string]: any;
  }

  export class Pool {
    constructor(config?: PoolConfig);
    connect(): Promise<PoolClient>;
    query(queryTextOrConfig: any, values?: any): Promise<QueryResult>;
    end(): Promise<void>;
    on(event: string, listener: (...args: any[]) => void): this;
    [key: string]: any;
  }
}
