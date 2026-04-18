import { NextResponse, type NextRequest } from 'next/server'

/**
 * Gate /dashboard and /admin behind the auth cookie.
 * Without bags_jwt set by /auth/login, redirect to landing page.
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
