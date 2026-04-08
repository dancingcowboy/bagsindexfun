import { NextResponse, type NextRequest } from 'next/server'

/**
 * Launch blackout — when SITE_HIDDEN=1 is set in the web env, every route
 * returns a black 404 page. Toggle off to reveal the site.
 */
export function middleware(req: NextRequest) {
  // Defense-in-depth: gate /dashboard and /admin behind the auth cookie.
  // Without bags_jwt set by /auth/login (which enforces the wallet allowlist),
  // bounce back to the landing page so non-allowlisted users can't poke around.
  const { pathname } = req.nextUrl
  if (pathname.startsWith('/dashboard') || pathname.startsWith('/admin')) {
    const hasAuth = req.cookies.get('bags_jwt')?.value
    if (!hasAuth) {
      const url = req.nextUrl.clone()
      url.pathname = '/'
      url.search = ''
      return NextResponse.redirect(url)
    }
  }

  if (process.env.SITE_HIDDEN !== '1') return NextResponse.next()

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<title>404 — Not Found</title>
<style>
  html,body{margin:0;padding:0;height:100%;background:#000;color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;}
  .wrap{display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:12px;}
  .code{font-size:88px;font-weight:700;letter-spacing:-2px;}
  .msg{font-size:14px;color:#888;text-transform:uppercase;letter-spacing:2px;}
</style>
</head>
<body>
  <div class="wrap">
    <div class="code">404</div>
    <div class="msg">Not Found</div>
  </div>
</body>
</html>`

  return new NextResponse(html, {
    status: 404,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
    },
  })
}

export const config = {
  // Match everything except Next internals and static assets
  matcher: ['/((?!_next/|favicon.ico|privy.svg|.*\\.(?:png|jpg|jpeg|svg|webp|ico|txt)$).*)'],
}
