import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-black text-zinc-200">
      <div className="mx-auto max-w-3xl px-6 py-12">
        <Link
          href="/"
          className="mb-8 inline-flex items-center gap-2 text-sm text-zinc-400 hover:text-emerald-400">
          <ArrowLeft size={14} /> Back home
        </Link>
        <article className="prose prose-invert max-w-none [&>h1]:text-emerald-400 [&>h2]:text-zinc-100 [&>h2]:mt-10 [&>h2]:mb-3 [&>h2]:text-xl [&>h2]:font-semibold [&>p]:leading-relaxed [&>p]:text-zinc-300 [&>ul]:list-disc [&>ul]:pl-6 [&>ul]:text-zinc-300 [&>ul>li]:my-1">
          {children}
        </article>
        <p className="mt-16 text-xs text-zinc-600">
          Bags Index · bagsindex.fun · support@bagsindex.fun
        </p>
      </div>
    </div>
  )
}
