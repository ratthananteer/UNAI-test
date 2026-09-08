import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BACKEND_URL =
  process.env.BACKEND_URL ||
  (process.env.NODE_ENV === "production"
    ? "https://unai-test.onrender.com"
    : "http://localhost:4000");

const AUTH_COOKIE = "unai_auth";

export async function POST(request: NextRequest) {
  const cookieHeader = request.headers.get("cookie") || "";
  const hasAuthCookie = request.cookies.has(AUTH_COOKIE);
  const target = `${BACKEND_URL.replace(/\/$/, "")}/api/auth/logout`;

  console.log("[AUTH][LOGOUT] request", { hasAuthCookie, target });

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: "POST",
      headers: cookieHeader ? { cookie: cookieHeader } : {},
      cache: "no-store",
      redirect: "manual",
    });
  } catch (error) {
    console.error("[AUTH][LOGOUT] backend request failed", error);
    const response = NextResponse.json({ ok: false, error: "Backend unavailable" }, { status: 502 });
    clearBrowserCookie(response);
    return response;
  }

  const body = await upstream.text();
  const contentType = upstream.headers.get("content-type") || "application/json";

  console.log("[AUTH][LOGOUT] backend response", {
    status: upstream.status,
    ok: upstream.ok,
  });

  const response = new NextResponse(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: {
      "content-type": contentType,
      "cache-control": "no-store, no-cache, must-revalidate",
      pragma: "no-cache",
    },
  });

  // The browser cookie belongs to the Next.js origin. Expire it explicitly
  // here rather than depending on a backend Set-Cookie crossing the proxy.
  clearBrowserCookie(response);
  return response;
}

function clearBrowserCookie(response: NextResponse) {
  response.cookies.set({
    name: AUTH_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
    expires: new Date(0),
  });
}
