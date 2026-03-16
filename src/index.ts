import type { ApolloServer, BaseContext, ContextFunction, HTTPGraphQLRequest } from '@apollo/server';
import { HeaderMap } from '@apollo/server';
import { execute, subscribe, parse, type GraphQLSchema } from 'graphql';
import { makeServer, handleProtocols } from 'graphql-ws';
import type { Context, MiddlewareHandler } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Argument passed to your context function for both HTTP and WS handlers. */
export interface HonoContextFunctionArgument {
    honoCtx: Context;
}

/** Options accepted by `httpHandler`. */
export interface HonoMiddlewareOptions<TContext extends BaseContext> {
    /**
     * A function that builds the GraphQL context value for every request.
     * Receives the Hono `Context` object so you can read headers, cookies, etc.
     * Defaults to returning an empty object `{}`.
     */
    context?: ContextFunction<[HonoContextFunctionArgument], TContext>;
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

function makeLegacyServer<TContext>(
    schema: GraphQLSchema,
    contextFn: (extra: HonoContextFunctionArgument) => Promise<TContext>,
) {
    return {
        opened(socket: WsSocket, extra: HonoContextFunctionArgument): () => Promise<void> {
            const subscriptions = new Map<string, AsyncIterableIterator<unknown>>();

            socket.onMessage(async (data) => {
                const message = JSON.parse(data);

                switch (message.type) {
                    case 'connection_init':
                        socket.send(JSON.stringify({ type: 'connection_ack' }));
                        break;

                    case 'start': {
                        const { id, payload } = message;
                        const document = parse(payload.query);
                        const ctx = await contextFn(extra);

                        const isSubscription = document.definitions.some(
                            (def) =>
                                def.kind === 'OperationDefinition' &&
                                (def as { operation: string }).operation === 'subscription',
                        );

                        if (isSubscription) {
                            const result = await subscribe({
                                schema,
                                document,
                                variableValues: payload.variables,
                                operationName: payload.operationName,
                                contextValue: ctx,
                            });

                            if (!(Symbol.asyncIterator in Object(result))) {
                                socket.send(
                                    JSON.stringify({
                                        type: 'error',
                                        id,
                                        payload: (result as { errors: unknown }).errors,
                                    }),
                                );
                                return;
                            }

                            const iterator = result as AsyncIterableIterator<unknown>;
                            subscriptions.set(id, iterator);

                            (async () => {
                                try {
                                    for await (const event of iterator) {
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
                                variableValues: payload.variables,
                                operationName: payload.operationName,
                                contextValue: ctx,
                            });
                            socket.send(JSON.stringify({ type: 'data', id, payload: result }));
                            socket.send(JSON.stringify({ type: 'complete', id }));
                        }
                        break;
                    }

                    case 'stop': {
                        const sub = subscriptions.get(message.id);
                        if (sub) {
                            await sub.return?.();
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
                    await iterator.return?.();
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
 */
export function httpHandler<TContext extends BaseContext>(
    server: ApolloServer<TContext>,
    options: HonoMiddlewareOptions<TContext> & Required<Pick<HonoMiddlewareOptions<TContext>, 'context'>>,
): MiddlewareHandler;
export function httpHandler<TContext extends BaseContext>(
    server: ApolloServer<TContext>,
    options?: HonoMiddlewareOptions<TContext>,
): MiddlewareHandler {
    server.assertStarted('httpHandler()');

    const contextFn = (options?.context ?? defaultContext) as ContextFunction<
        [HonoContextFunctionArgument],
        TContext
    >;

    return async (c) => {
        // Convert Hono headers → Apollo HeaderMap (keys must be lowercase).
        const headers = new HeaderMap();
        c.req.raw.headers.forEach((value, key) => {
            headers.set(key, value);
        });

        // Parse body for non-GET/HEAD requests.
        let body: Record<string, unknown> | string | undefined;
        if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
            const contentType = c.req.header('content-type') ?? '';
            if (contentType.includes('application/json')) {
                // Read as text first so the stream is only consumed once.
                const raw = await c.req.text();
                if (raw === '') {
                    // Empty body — pass undefined so Apollo returns 400 itself.
                    body = undefined;
                } else {
                    try {
                        body = JSON.parse(raw) as Record<string, unknown>;
                    } catch {
                        return new Response(
                            JSON.stringify({ errors: [{ message: 'Invalid JSON in request body' }] }),
                            { status: 400, headers: { 'content-type': 'application/json' } },
                        );
                    }
                }
            } else {
                body = await c.req.text();
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

        if (result.body.kind === 'complete') {
            return new Response(result.body.string, {
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
                    controller.enqueue(encoder.encode(value));
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
 * Client ≥ 3.5) and the legacy `graphql-ws` / `subscriptions-transport-ws`
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
    const contextFn = (options.context ?? defaultContext) as ContextFunction<
        [HonoContextFunctionArgument],
        TContext
    >;

    // Lazily initialised — only created on the first connection that needs each protocol.
    let newProtocolServer: ReturnType<typeof makeServer> | null = null;
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
                    newProtocolServer ??= makeServer({
                        schema,
                        execute,
                        subscribe,
                        context: (ctx) => {
                            const { honoCtx } = ctx.extra as { honoCtx: Context };
                            return contextFn({ honoCtx });
                        },
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
