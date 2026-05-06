import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { getSession, type Session } from '@/lib/session';

export default async function LandingPage() {
  const session = await getSession();
  return (
    <main className="flex min-h-screen flex-col">
      <Header session={session} />
      <Hero session={session} />
      <ValueProps />
      <CallToAction session={session} />
      <Footer />
    </main>
  );
}

function Header({ session }: { session: Session | null }) {
  const dashboardHref = session?.isAdmin ? '/admin' : '/dashboard';
  return (
    <header className="border-b border-slate-200">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link href="/" className="text-base font-semibold tracking-tight">
          myauthservice
        </Link>
        <nav className="flex items-center gap-2">
          {session ? (
            <Link href={dashboardHref}>
              <Button variant="accent" size="sm">
                Go to {session.isAdmin ? 'admin' : 'dashboard'}
              </Button>
            </Link>
          ) : (
            <>
              <Link href="/login">
                <Button variant="ghost" size="sm">
                  Log in
                </Button>
              </Link>
              <Link href="/register">
                <Button variant="accent" size="sm">
                  Get started
                </Button>
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}

function Hero({ session }: { session: Session | null }) {
  const dashboardHref = session?.isAdmin ? '/admin' : '/dashboard';
  return (
    <section className="border-b border-slate-200">
      <div className="mx-auto grid max-w-6xl gap-12 px-6 py-24 md:grid-cols-2 md:items-center">
        <div className="flex flex-col gap-6">
          <p className="text-sm font-medium uppercase tracking-wider text-brand-accent">
            Drop-in auth for your apps
          </p>
          <h1 className="text-balance text-5xl font-semibold tracking-tight md:text-6xl">
            Stop rebuilding login.<br />
            <span className="text-brand-accent">Ship the rest.</span>
          </h1>
          <p className="text-balance text-lg text-slate-600">
            Hosted authentication with email verification, MFA, and JWTs your services verify in
            ten lines of code. Deploy once, brand it per app.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            {session ? (
              <Link href={dashboardHref}>
                <Button variant="accent" size="lg">
                  Go to {session.isAdmin ? 'admin' : 'dashboard'}
                </Button>
              </Link>
            ) : (
              <>
                <Link href="/register">
                  <Button variant="accent" size="lg">
                    Create your account
                  </Button>
                </Link>
                <Link href="/login">
                  <Button variant="outline" size="lg">
                    Log in
                  </Button>
                </Link>
              </>
            )}
          </div>
          <p className="text-sm text-slate-500">No credit card required. 60 seconds to first JWT.</p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-slate-950 p-6 font-mono text-sm shadow-xl">
          <pre className="overflow-x-auto text-slate-100">
            <code>{`import { jwtVerify, createRemoteJWKSet } from 'jose';

const JWKS = createRemoteJWKSet(
  new URL('https://auth.myauthservice.com/.well-known/jwks.json')
);

export async function verify(token) {
  const { payload } = await jwtVerify(token, JWKS, {
    issuer: 'https://auth.myauthservice.com',
    audience: 'myauthservice',
  });
  return payload;
}`}</code>
          </pre>
        </div>
      </div>
    </section>
  );
}

function ValueProps() {
  const items = [
    {
      title: 'Per-app branding',
      body: 'Each consuming service sends its own verify and reset emails from its own domain. Users never see another product’s name.',
    },
    {
      title: 'Stateless verification',
      body: 'Issue rotating JWTs. Other services verify against /.well-known/jwks.json — no callback, no DB hit on every request.',
    },
    {
      title: 'TOTP MFA + sessions',
      body: 'Refresh-token rotation, revocable sessions, TOTP enrollment. Audit log of every auth event in Postgres.',
    },
  ];

  return (
    <section className="border-b border-slate-200 bg-slate-50">
      <div className="mx-auto grid max-w-6xl gap-8 px-6 py-20 md:grid-cols-3">
        {items.map((it) => (
          <div key={it.title} className="flex flex-col gap-2">
            <h3 className="text-lg font-semibold tracking-tight">{it.title}</h3>
            <p className="text-sm text-slate-600">{it.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function CallToAction({ session }: { session: Session | null }) {
  const dashboardHref = session?.isAdmin ? '/admin' : '/dashboard';
  return (
    <section className="border-b border-slate-200">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-6 px-6 py-20 text-center">
        <h2 className="text-balance text-3xl font-semibold tracking-tight md:text-4xl">
          Ready in the time it took to read this page.
        </h2>
        <p className="max-w-xl text-balance text-slate-600">
          Create your account, provision a service client, and start verifying tokens in your app
          today.
        </p>
        <Link href={session ? dashboardHref : '/register'}>
          <Button variant="accent" size="lg">
            {session ? `Go to ${session.isAdmin ? 'admin' : 'dashboard'}` : 'Create your account'}
          </Button>
        </Link>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="mt-auto">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 py-10 text-sm text-slate-500 md:flex-row">
        <p>&copy; {new Date().getFullYear()} myauthservice</p>
        <nav className="flex gap-4">
          <Link href="/login" className="hover:text-slate-900">
            Log in
          </Link>
          <Link href="/register" className="hover:text-slate-900">
            Sign up
          </Link>
          <a
            href="https://github.com/proark1/auth"
            className="hover:text-slate-900"
            target="_blank"
            rel="noreferrer"
          >
            Source
          </a>
        </nav>
      </div>
    </footer>
  );
}
