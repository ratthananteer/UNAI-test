import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BACKEND_URL =
  process.env.BACKEND_URL ||
  (process.env.NODE_ENV === "production"
    ? "https://unai-backend.onrender.com"
    : "http://localhost:4000");

const AUTH_COOKIE = "unai_auth";

const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "content-length", "host",
]);

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const suffix = path.map((part) => encodeURIComponent(part)).join("/");
  const isLogout = request.method === "POST" && suffix === "auth/logout";
  const hasAuthCookie = request.cookies.has(AUTH_COOKIE);
  const target = `${BACKEND_URL.replace(/\/$/, "")}/api/${suffix}${request.nextUrl.search}`;

  if (isLogout) {
    console.log("[AUTH][PROXY] logout request received", { method: request.method, suffix, hasAuthCookie, target });
  }

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  });

  const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer();

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
      cache: "no-store",
    });
  } catch (error) {
    console.error("[API Proxy] Backend request failed:", target, error);
    return NextResponse.json(
      { error: "Backend unavailable", details: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase()) && key.toLowerCase() !== "set-cookie") {
      responseHeaders.set(key, value);
    }
  });

  const setCookies = typeof upstream.headers.getSetCookie === "function"
    ? upstream.headers.getSetCookie()
    : upstream.headers.get("set-cookie");

  if (Array.isArray(setCookies)) {
    for (const cookie of setCookies) responseHeaders.append("set-cookie", cookie);
  } else if (setCookies) {
    responseHeaders.set("set-cookie", setCookies);
  }

  if (isLogout) {
    console.log("[AUTH][PROXY] backend logout response", {
      status: upstream.status,
      ok: upstream.ok,
      hasSetCookie: Array.isArray(setCookies) ? setCookies.length > 0 : Boolean(setCookies),
    });
  }

  const response = new NextResponse(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });

  if (isLogout) {
    response.cookies.set({
      name: AUTH_COOKIE,
      value: "",
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 0,
    });
    console.log("[AUTH][PROXY] browser auth cookie explicitly cleared", { cookie: AUTH_COOKIE });
  }

  return response;
}

export async function GET(request: NextRequest, context: { params: Promise<{ path: string[] }> }) { return proxy(request, context); }
export async function POST(request: NextRequest, context: { params: Promise<{ path: string[] }> }) { return proxy(request, context); }
export async function PUT(request: NextRequest, context: { params: Promise<{ path: string[] }> }) { return proxy(request, context); }
export async function PATCH(request: NextRequest, context: { params: Promise<{ path: string[] }> }) { return proxy(request, context); }
export async function DELETE(request: NextRequest, context: { params: Promise<{ path: string[] }> }) { return proxy(request, context); }
export async function OPTIONS(request: NextRequest, context: { params: Promise<{ path: string[] }> }) { return proxy(request, context); }
export async function HEAD(request: NextRequest, context: { params: Promise<{ path: string[] }> }) { return proxy(request, context); }
