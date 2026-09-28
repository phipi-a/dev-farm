import type { CredentialProvider } from "../config/config";
import type { LinearComment, LinearIssue, LinearIssueUpdateInput } from "./types";
import type { LinearTransport } from "./transport";

/** The smallest HTTP seam needed by the production adapter. */
export interface LinearHttpRequest {
  readonly method: "POST";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface LinearHttpResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface LinearHttpPort {
  request(request: LinearHttpRequest): Promise<LinearHttpResponse>;
}

export interface LinearApiOptions {
  readonly endpoint?: string;
  readonly credentialName?: "LINEAR_API_TOKEN";
}

export class LinearProviderError extends Error {
  readonly operation: string;
  readonly status?: number;

  public constructor(operation: string, status?: number) {
    super(
      status === undefined
        ? `Linear ${operation} request failed`
        : `Linear ${operation} request failed with status ${status}`,
    );
    this.name = "LinearProviderError";
    this.operation = operation;
    this.status = status;
  }
}

interface LinearGraphQlResult {
  readonly data?: Record<string, unknown>;
  readonly errors?: readonly unknown[];
}

interface CachedIssue {
  readonly teamId?: string;
  readonly stateIds: ReadonlyMap<string, string>;
}

const DEFAULT_ENDPOINT = "https://api.linear.app/graphql";

/**
 * Linear's GraphQL API behind the existing transport port. The HTTP client and
 * credential source are injected so this module performs no ambient I/O.
 */
export class LinearApiTransport implements LinearTransport {
  readonly #http: LinearHttpPort;
  readonly #credentials: CredentialProvider;
  readonly #endpoint: string;
  readonly #credentialName: "LINEAR_API_TOKEN";
  readonly #issues = new Map<string, CachedIssue>();

  public constructor(
    http: LinearHttpPort,
    credentials: CredentialProvider,
    options: LinearApiOptions = {},
  ) {
    if (http === null || typeof http.request !== "function") {
      throw new TypeError("a Linear HTTP port is required");
    }
    if (credentials === null || typeof credentials.get !== "function") {
      throw new TypeError("a credential provider is required");
    }
    this.#http = http;
    this.#credentials = credentials;
    this.#endpoint = safeEndpoint(options.endpoint ?? DEFAULT_ENDPOINT);
    this.#credentialName = options.credentialName ?? "LINEAR_API_TOKEN";
  }

  public async getIssue(identifier: string): Promise<LinearIssue | null> {
    const result = await this.#request(
      "get issue",
      `
      query GetIssue($identifier: String!) {
        issue(identifier: $identifier) {
          id identifier title description url
          team { id }
          state { id name type }
          team { states { nodes { id name type } } }
        }
      }
    `,
      { identifier },
    );
    const issue = asRecord(result.issue);
    if (issue === undefined) {
      return null;
    }
    const state = asRecord(issue.state);
    const team = asRecord(issue.team);
    const states = asRecord(team?.states);
    const stateNodes = Array.isArray(states?.nodes) ? states.nodes : [];
    const stateIds = new Map<string, string>();
    for (const node of stateNodes) {
      const record = asRecord(node);
      const id = stringValue(record?.id);
      const name = stringValue(record?.name);
      if (id !== undefined && name !== undefined) stateIds.set(name, id);
    }
    const issueId = requiredField(issue.id, "get issue");
    this.#issues.set(issueId, {
      teamId: stringValue(team?.id),
      stateIds,
    });
    return toIssue(issue, state);
  }

  public async updateIssue(input: LinearIssueUpdateInput): Promise<LinearIssue> {
    const cached = this.#issues.get(input.issueId);
    const stateId = cached?.stateIds.get(input.status);
    if (stateId === undefined) {
      // A state id is deliberately not guessed from a human-readable name.
      throw new LinearProviderError("update issue: workflow state is not available");
    }
    const result = await this.#request(
      "update issue",
      `
      mutation UpdateIssue($issueId: String!, $stateId: String!) {
        issueUpdate(id: $issueId, input: { stateId: $stateId }) {
          success issue { id identifier title description url state { id name type } team { id } }
        }
      }
    `,
      { issueId: input.issueId, stateId },
    );
    const mutation = asRecord(result.issueUpdate);
    const issue = asRecord(mutation?.issue);
    if (issue === undefined) throw new LinearProviderError("update issue");
    return toIssue(issue, asRecord(issue.state));
  }

  public async createComment(input: { identifier: string; body: string }): Promise<LinearComment> {
    const issue = await this.getIssue(input.identifier);
    if (issue === null) throw new LinearProviderError("create comment: issue not found");
    const result = await this.#request(
      "create comment",
      `
      mutation CreateComment($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success comment { id body createdAt updatedAt user { name } issue { identifier } }
        }
      }
    `,
      { issueId: issue.id, body: input.body },
    );
    const mutation = asRecord(result.commentCreate);
    const comment = asRecord(mutation?.comment);
    if (comment === undefined) throw new LinearProviderError("create comment");
    return {
      id: requiredField(comment.id, "create comment"),
      issueIdentifier: stringValue(asRecord(comment.issue)?.identifier) ?? input.identifier,
      body: stringValue(comment.body) ?? input.body,
      authorName: stringValue(asRecord(comment.user)?.name),
      createdAt: stringValue(comment.createdAt),
      updatedAt: stringValue(comment.updatedAt),
    };
  }

  async #request(
    operation: string,
    query: string,
    variables: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const token = this.#credentials.get(this.#credentialName);
    if (token === undefined || token.length === 0) {
      throw new LinearProviderError(`${operation}: credential is not configured`);
    }
    let response: LinearHttpResponse;
    try {
      response = await this.#http.request({
        method: "POST",
        url: this.#endpoint,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch {
      // An HTTP implementation may include response bodies or authorization
      // details in its error. Provider boundaries expose only safe diagnostics.
      throw new LinearProviderError(operation);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new LinearProviderError(operation, response.status);
    }
    const payload = parseResponse(response.body, operation);
    if (payload.errors !== undefined && payload.errors.length > 0) {
      throw new LinearProviderError(operation);
    }
    if (payload.data === undefined) throw new LinearProviderError(operation);
    return payload.data;
  }
}

function safeEndpoint(value: string): string {
  try {
    const url = new URL(value);
    if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
      throw new Error();
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
    return url.toString();
  } catch {
    throw new TypeError("Linear endpoint must be an HTTP URL without credentials");
  }
}

function parseResponse(body: unknown, operation: string): LinearGraphQlResult {
  if (typeof body === "string") {
    try {
      body = JSON.parse(body) as unknown;
    } catch {
      throw new LinearProviderError(operation);
    }
  }
  const record = asRecord(body);
  if (record === undefined) throw new LinearProviderError(operation);
  return record as unknown as LinearGraphQlResult;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requiredField(value: unknown, operation: string): string {
  const result = stringValue(value);
  if (result === undefined || result.length === 0) throw new LinearProviderError(operation);
  return result;
}

function toIssue(
  value: Record<string, unknown>,
  state: Record<string, unknown> | undefined,
): LinearIssue {
  const issueId = requiredField(value.id, "get issue");
  return {
    id: issueId,
    identifier: requiredField(value.identifier, "get issue"),
    title: stringValue(value.title) ?? "",
    description: stringValue(value.description),
    url: stringValue(value.url),
    status: {
      id: requiredField(state?.id, "get issue"),
      name: requiredField(state?.name, "get issue"),
      type: stringValue(state?.type),
    },
    teamId: stringValue(asRecord(value.team)?.id),
  };
}

/** Alias useful to composition roots that call all provider transports "clients". */
export const LinearProviderTransport = LinearApiTransport;

export function createLinearApiTransport(
  http: LinearHttpPort,
  credentials: CredentialProvider,
  options: LinearApiOptions = {},
): LinearApiTransport {
  return new LinearApiTransport(http, credentials, options);
}
