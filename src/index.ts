import type { ApolloServer, BaseContext, ContextFunction, HTTPGraphQLRequest } from '@apollo/server';
import { HeaderMap } from '@apollo/server';
import { execute, subscribe, parse, getOperationAST, type ExecutionResult, type GraphQLSchema } from 'graphql';
import { makeServer, handleProtocols, type Server } from 'graphql-ws';
import type { Context, Env, MiddlewareHandler } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Runtime guard: value is a plain object indexable as `Record<string, unknown>`. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** Runtime guard: discriminates `subscribe()` results into async iterator vs error. */
function isAsyncIterable(
    value: AsyncGenerator<ExecutionResult> | ExecutionResult,
): value is AsyncGenerator<ExecutionResult> {
    return Symbol.asyncIterator in value;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Argument passed to your context function for both HTTP and WS handlers.
 *
 * The `E` generic flows through from the handler options so that `honoCtx`
 * carries your application's typed variables and bindings.
 */
export interface HonoContextFunctionArgument<E extends Env = Env> {
    honoCtx: Context<E>;
}

/**
 * Options accepted by `httpHandler`.
 *
 * @typeParam TContext - The GraphQL context type for `ApolloServer<TContext>`.
 * @typeParam E       - The Hono `Env` type, giving the hooks and context
 *                      function access to typed `c.get()` / `c.set()` variables.
 */
export interface HonoMiddlewareOptions<TContext extends BaseContext, E extends Env = Env> {
    /**
     * A function that builds the GraphQL context value for every request.
     * Receives the Hono `Context` object so you can read headers, cookies, etc.
     * Defaults to returning an empty object `{}`.
     */
    context?: ContextFunction<[HonoContextFunctionArgument<E>], TContext>;
    /**
     * Transform the **incoming** request body before Apollo Server processes it.
     * Called with the already-parsed JSON value — use this to decrypt an
     * encrypted body. The value is typed `unknown`; validate before using
     * (e.g. with Zod).
     *
     * Must return the plaintext GraphQL request object
     * (e.g. `{ query, variables, operationName }`).
     *
     * @param body     - The parsed JSON body received from the client.
     * @param honoCtx  - The Hono `Context`, e.g. to read request headers.
     * @returns The GraphQL request object for Apollo to execute.
     */
    onRequestBody?: (body: unknown, honoCtx: Context<E>) => Promise<unknown> | unknown;
    /**
     * Transform the **outgoing** response body before it is sent to the client.
     * Called with the parsed GraphQL JSON value produced by Apollo — use this
     * to encrypt the response. The value is typed `unknown`; validate before
     * using (e.g. with Zod).
     *
     * The return value is JSON-serialised and sent as the response body.
     * For chunked responses (`@defer` / `@stream` / subscriptions) this is
     * called once per chunk.
     *
     * @param body     - The parsed GraphQL response produced by Apollo.
     * @param honoCtx  - The Hono `Context`, e.g. to read request headers.
     * @returns Any JSON-serialisable value to send to the client.
     */
    onResponseBody?: (body: unknown, honoCtx: Context<E>) => Promise<unknown> | unknown;
    /**
     * The GraphQL schema. Required for subscription support over HTTP multipart
     * (`multipart/mixed; subscriptionSpec=1.0`), which is the transport used by
     * Apollo iOS 2.x.
     *
     * When provided and the incoming operation is a `subscription`, the handler
     * executes it directly with graphql-js and streams each event as a
     * `multipart/mixed` chunk, bypassing Apollo Server's HTTP handler.
     * `onResponseBody` is applied to every chunk so encryption is transparent.
     */
    schema?: GraphQLSchema;
}

/** Options accepted by `wsHandler`. */
export interface HonoWsHandlerOptions<TContext extends BaseContext> {
    /**
     * The GraphQL schema used for subscription execution.
     * Must be the same schema passed to `ApolloServer`.
     */
    schema: GraphQLSchema;
    /**
     * The runtime-specific `upgradeWebSocket` function from Hono.
     *
     * @example Bun
     * ```ts
     * import { upgradeWebSocket } from 'hono/bun';
     * ```
     * @example Cloudflare Workers
     * ```ts
     * import { upgradeWebSocket } from 'hono/cloudflare-workers';
     * ```
     * @example Deno
     * ```ts
     * import { upgradeWebSocket } from 'hono/deno';
     * ```
     */
    upgradeWebSocket: UpgradeWebSocket;
    /**
     * A function that builds the GraphQL context value for every WebSocket
     * connection. Receives the Hono `Context` at upgrade time.
     * Defaults to returning an empty object `{}`.
     */
    context?: ContextFunction<[HonoContextFunctionArgument], TContext>;
}

// ---------------------------------------------------------------------------
// Internal defaults
// ---------------------------------------------------------------------------

const defaultContext: ContextFunction<[HonoContextFunctionArgument], BaseContext> =
    async () => ({});

// ---------------------------------------------------------------------------
// Internal: legacy subscriptions-transport-ws protocol server
// ---------------------------------------------------------------------------

interface WsSocket {
    send: (data: string) => void;
    close: (code?: number, reason?: string) => void;
    onMessage: (cb: (data: string) => Promise<void>) => void;
}

/** Extra context attached to each WebSocket connection for graphql-ws. */
type WsExtra = { honoCtx: Context };

function makeLegacyServer<TContext>(
    schema: GraphQLSchema,
    contextFn: (extra: HonoContextFunctionArgument) => Promise<TContext>,
) {
    return {
        opened(socket: WsSocket, extra: HonoContextFunctionArgument): () => Promise<void> {
            const subscriptions = new Map<string, AsyncGenerator<ExecutionResult>>();

            socket.onMessage(async (data) => {
                const message: unknown = JSON.parse(data);
                if (!isRecord(message)) return;

                switch (message.type) {
                    case 'connection_init':
                        socket.send(JSON.stringify({ type: 'connection_ack' }));
                        break;

                    case 'start': {
                        const id = message.id;
                        if (typeof id !== 'string') return;
                        if (!isRecord(message.payload)) return;

                        const payload = message.payload;
                        if (typeof payload.query !== 'string') return;

                        const document = parse(payload.query);
                        const ctx = await contextFn(extra);

                        const isSubscription = document.definitions.some(
                            (def) => def.kind === 'OperationDefinition' && def.operation === 'subscription',
                        );

                        const variableValues = isRecord(payload.variables) ? payload.variables : undefined;
                        const operationName = typeof payload.operationName === 'string'
                            ? payload.operationName
                            : undefined;

                        if (isSubscription) {
                            const result = await subscribe({
                                schema,
                                document,
                                variableValues,
                                operationName,
                                contextValue: ctx,
                            });

                            if (!isAsyncIterable(result)) {
                                socket.send(
                                    JSON.stringify({ type: 'error', id, payload: result.errors }),
                                );
                                return;
                            }

                            subscriptions.set(id, result);

                            (async () => {
                                try {
                                    for await (const event of result) {
                                        if (!subscriptions.has(id)) break;
                                        socket.send(JSON.stringify({ type: 'data', id, payload: event }));
                                    }
                                } finally {
                                    subscriptions.delete(id);
                                    socket.send(JSON.stringify({ type: 'complete', id }));
                                }
                            })();
                        } else {
                            const result = await execute({
                                schema,
                                document,
                                variableValues,
                                operationName,
                                contextValue: ctx,
                            });
                            socket.send(JSON.stringify({ type: 'data', id, payload: result }));
                            socket.send(JSON.stringify({ type: 'complete', id }));
                        }
                        break;
                    }

                    case 'stop': {
                        if (typeof message.id !== 'string') return;
                        const sub = subscriptions.get(message.id);
                        if (sub) {
                            await sub.return(undefined);
                            subscriptions.delete(message.id);
                        }
                        break;
                    }

                    case 'connection_terminate':
                        socket.close(1000);
                        break;
                }
            });

            return async () => {
                for (const [, iterator] of subscriptions) {
                    await iterator.return(undefined);
                }
                subscriptions.clear();
            };
        },
    };
}

// ---------------------------------------------------------------------------
// HTTP handler — queries & mutations
// ---------------------------------------------------------------------------

/**
 * Creates a Hono middleware that handles GraphQL HTTP requests (queries and
 * mutations) via Apollo Server.
 *
 * Overload without a context function — Apollo Server receives `BaseContext`.
 */
export function httpHandler(
    server: ApolloServer<BaseContext>,
    options?: HonoMiddlewareOptions<BaseContext>,
): MiddlewareHandler;
/**
 * Overload with a context function — the generic `TContext` is inferred from
 * the `context` option so that `ApolloServer<TContext>` stays consistent.
 *
 * The `E` generic lets hooks and context functions receive a typed Hono
 * `Context<E>` with access to your application's variables and bindings.
 */
export function httpHandler<TContext extends BaseContext, E extends Env = Env>(
    server: ApolloServer<TContext>,
    options: HonoMiddlewareOptions<TContext, E> & Required<Pick<HonoMiddlewareOptions<TContext, E>, 'context'>>,
): MiddlewareHandler;
export function httpHandler<TContext extends BaseContext, E extends Env = Env>(
    server: ApolloServer<TContext>,
    options?: HonoMiddlewareOptions<TContext, E>,
): MiddlewareHandler {
    server.assertStarted('httpHandler()');

    // When options.context is undefined the first overload constrains
    // TContext = BaseContext, so defaultContext satisfies the return type.
    const contextFn = (options?.context ?? defaultContext) as ContextFunction<
        [HonoContextFunctionArgument<E>],
        TContext
    >;

    return async (c, next) => {
        // WebSocket upgrade requests must be handled by wsHandler, not here.
        if (c.req.header('upgrade')?.toLowerCase() === 'websocket') {
            return next();
        }

        // Convert Hono headers → Apollo HeaderMap (keys must be lowercase).
        const headers = new HeaderMap();
        c.req.raw.headers.forEach((value, key) => {
            headers.set(key, value);
        });

        // Parse body as JSON for POST, then optionally transform (e.g. decrypt).
        // GET requests carry the query in the URL search params — no body to parse.
        let body: unknown;
        if (c.req.method === 'POST') {
            try {
                const parsed: unknown = await c.req.json();
                body = options?.onRequestBody ? await options.onRequestBody(parsed, c) : parsed;
            } catch {
                return new Response(
                    JSON.stringify({ errors: [{ message: 'Invalid JSON in request body' }] }),
                    { status: 400, headers: { 'content-type': 'application/json' } },
                );
            }
        }

        // Subscription over HTTP multipart — used by Apollo iOS 2.x.
        // Detect a subscription by parsing the query AST, then stream events
        // as multipart/mixed chunks with optional response transformation.
        if (options?.schema && isRecord(body)) {
            const queryStr = typeof body.query === 'string' ? body.query : null;
            if (queryStr) {
                const opName = typeof body.operationName === 'string' ? body.operationName : undefined;
                const opDef = getOperationAST(parse(queryStr), opName ?? null);
                if (opDef?.operation === 'subscription') {
                    const variables = isRecord(body.variables) ? body.variables : undefined;
                    const contextValue = await contextFn({ honoCtx: c });
                    const subscribeResult = await subscribe({
                        schema: options.schema,
                        document: parse(queryStr),
                        variableValues: variables,
                        operationName: opName,
                        contextValue,
                    });

                    if (!isAsyncIterable(subscribeResult)) {
                        return new Response(
                            JSON.stringify(subscribeResult),
                            { status: 400, headers: { 'content-type': 'application/json' } },
                        );
                    }

                    const boundary = 'graphql';
                    const encoder = new TextEncoder();

                    let cancelled = false;
                    const readable = new ReadableStream({
                        start(controller) {
                            (async () => {
                                try {
                                    for await (const value of subscribeResult) {
                                        if (cancelled) break;
                                        const envelope = { payload: value };
                                        let chunkBody: string;
                                        if (options.onResponseBody) {
                                            const transformed = await options.onResponseBody(envelope, c);
                                            chunkBody = JSON.stringify(transformed);
                                        } else {
                                            chunkBody = JSON.stringify(envelope);
                                        }
                                        const part = `--${boundary}\r\nContent-Type: application/json\r\n\r\n${chunkBody}\r\n`;
                                        controller.enqueue(encoder.encode(part));
                                    }
                                } catch { /* stream cancelled or iterator threw */ }
                                if (!cancelled) {
                                    controller.enqueue(encoder.encode(`--${boundary}--\r\n`));
                                    controller.close();
                                }
                            })();
                        },
                        cancel() {
                            cancelled = true;
                            void subscribeResult.return(undefined);
                        },
                    });

                    return new Response(readable, {
                        status: 200,
                        headers: { 'content-type': `multipart/mixed; boundary="${boundary}"; subscriptionSpec=1.0` },
                    });
                }
            }
        }

        const url = new URL(c.req.url);
        const httpGraphQLRequest: HTTPGraphQLRequest = {
            method: c.req.method.toUpperCase(),
            headers,
            search: url.search,
            body,
        };

        const result = await server.executeHTTPGraphQLRequest({
            httpGraphQLRequest,
            context: () => contextFn({ honoCtx: c }),
        });

        // Forward Apollo response headers.
        const responseHeaders: Record<string, string> = {};
        result.headers.forEach((value, key) => {
            responseHeaders[key] = value;
        });

        // Helper: parse, transform, re-serialise a response body string.
        // Non-JSON bodies (e.g. Apollo's HTML landing page) pass through unchanged.
        const applyResponseTransform = async (bodyString: string): Promise<string> => {
            if (!options?.onResponseBody) return bodyString;
            try {
                const parsed: unknown = JSON.parse(bodyString);
                const transformed = await options.onResponseBody(parsed, c);
                return JSON.stringify(transformed);
            } catch {
                return bodyString;
            }
        };

        if (result.body.kind === 'complete') {
            return new Response(await applyResponseTransform(result.body.string), {
                status: result.status ?? 200,
                headers: responseHeaders,
            });
        }

        // Chunked / incremental delivery (e.g. `@defer` / `@stream`).
        const { asyncIterator } = result.body;
        const encoder = new TextEncoder();

        const readable = new ReadableStream({
            async pull(controller) {
                const { value, done } = await asyncIterator.next();
                if (done) {
                    controller.close();
                } else {
                    const chunk = await applyResponseTransform(value);
                    controller.enqueue(encoder.encode(chunk));
                }
            },
            cancel() {
                asyncIterator.return?.();
            },
        });

        return new Response(readable, {
            status: result.status ?? 200,
            headers: responseHeaders,
        });
    };
}

// ---------------------------------------------------------------------------
// WebSocket handler — subscriptions (Bun runtime)
// ---------------------------------------------------------------------------

/**
 * Creates a Hono middleware that upgrades HTTP connections to WebSockets for
 * GraphQL subscriptions.
 *
 * Supports both the modern `graphql-transport-ws` protocol (used by Apollo
 * Client >= 3.5) and the legacy `graphql-ws` / `subscriptions-transport-ws`
 * protocol.
 *
 * Supports Bun, Cloudflare Workers, and Deno via Hono's `upgradeWebSocket`
 * helper. Pass the runtime-specific function in `options.upgradeWebSocket`.
 *
 * @param server  - A started `ApolloServer` instance (used only for the
 *                  `assertStarted` guard).
 * @param options - Must include `schema` and `upgradeWebSocket`. Optionally
 *                  includes a `context` function.
 */
export function wsHandler<TContext extends BaseContext>(
    server: ApolloServer<TContext>,
    options: HonoWsHandlerOptions<TContext>,
): MiddlewareHandler {
    server.assertStarted('wsHandler()');

    const { schema, upgradeWebSocket } = options;
    // Same overload reasoning as httpHandler: safe when context is absent.
    const contextFn = (options.context ?? defaultContext) as ContextFunction<
        [HonoContextFunctionArgument],
        TContext
    >;

    // Lazily initialised — only created on the first connection that needs each protocol.
    let newProtocolServer: Server<WsExtra> | null = null;
    let legacyProtocolServer: ReturnType<typeof makeLegacyServer> | null = null;

    return upgradeWebSocket((c) => {
        const protocolHeader = c.req.header('sec-websocket-protocol') ?? '';
        const protocols = protocolHeader.split(',').map((p) => p.trim());
        const protocol =
            handleProtocols(protocolHeader) ||
            (protocols.includes('graphql-ws') ? 'graphql-ws' : null);

        let closeConnection: (() => Promise<void>) | null = null;
        let messageCallback: ((data: string) => Promise<void>) | null = null;

        const socket: WsSocket = {
            send: (_data) => { /* replaced in onOpen */ },
            close: (_code, _reason) => { /* replaced in onOpen */ },
            onMessage: (cb) => { messageCallback = cb; },
        };

        return {
            onOpen: (_event, ws) => {
                if (!protocol) return ws.close(1002, 'Unsupported WebSocket protocol');

                socket.send = (data) => ws.send(data);
                socket.close = (code, reason) => ws.close(code, reason);

                if (protocol === 'graphql-transport-ws') {
                    newProtocolServer ??= makeServer<Record<string, unknown> | undefined, WsExtra>({
                        schema,
                        execute,
                        subscribe,
                        context: (ctx) => contextFn({ honoCtx: ctx.extra.honoCtx }),
                    });
                    closeConnection = newProtocolServer.opened(
                        {
                            protocol,
                            send: socket.send,
                            close: socket.close,
                            onMessage: (cb) => { messageCallback = cb; },
                        },
                        { honoCtx: c },
                    );
                } else {
                    legacyProtocolServer ??= makeLegacyServer(schema, (extra) => contextFn(extra));
                    closeConnection = legacyProtocolServer.opened(socket, { honoCtx: c });
                }
            },
            onMessage: (event) => {
                messageCallback?.(event.data.toString());
            },
            onClose: () => {
                closeConnection?.();
            },
        };
    });
}
