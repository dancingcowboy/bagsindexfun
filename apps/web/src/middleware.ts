import { NextResponse, type NextRequest } from 'next/server'

/**
 * Defense-in-depth: gate /dashboard and /admin behind the auth cookie.
 * Without bags_jwt set by /auth/login (which enforces the wallet allowlist),
 * bounce back to the landing page so non-allowlisted users can't poke around.
 */
export function middleware(req: NextRequest) {
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
  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/|favicon.ico|privy.svg|.*\\.(?:png|jpg|jpeg|svg|webp|ico|txt)$).*)'],
}
