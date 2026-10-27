import { useEffect, useRef, useState } from 'react';
import { useAuth, SignIn, SignUp } from '@clerk/clerk-react';
import { Redirect } from 'wouter';
import {
  CheckSquare,
  TrendingUp,
  Users,
  Map,
  ClipboardList,
  Briefcase,
  ArrowRight,
  BarChart3,
  Layers,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn, safeRedirectPath } from '@/lib/utils';
import { SeoHead } from '@/components/SeoHead';
import { buildSoftwareApp, buildFAQ } from '@/lib/structured-data';

// The landing page is Spanish (es-MX) because it targets MX search; the signed-in app is English.
// Only claim what the app actually does: access needs a ninja-stack subscription (no free plan).
const FAQ_ITEMS = [
  {
    question: '¿Qué es Ninja Planner y para quién está pensado?',
    answer: 'Ninja Planner es un planificador de equipo y dashboard empresarial diseñado para pymes y equipos en México y LATAM. Centraliza tareas, metas, roadmap y métricas de negocio en un solo workspace.',
  },
  {
    question: '¿Cómo ayuda Ninja Planner a organizar a mi equipo?',
    answer: 'Con tableros Kanban, asignación de tareas, seguimiento de sprints y un dashboard compartido, todo el equipo ve el trabajo pendiente, los avances y los bloqueos.',
  },
  {
    question: '¿Puedo monitorear las métricas de negocio desde Ninja Planner?',
    answer: 'Sí. Puedes definir metas de ingresos mensuales, trimestrales o anuales y registrar los ingresos reales para ver el avance frente a la meta, junto con el progreso de tus objetivos y la carga de trabajo del equipo.',
  },
  {
    question: '¿Cómo empiezo a usar Ninja Planner?',
    answer: 'Crea tu cuenta, crea el workspace de tu equipo e invita a tus compañeros con un enlace de invitación. El acceso continuo se activa con una suscripción de ninja-stack.',
  },
  {
    question: '¿Ninja Planner funciona para equipos remotos o híbridos?',
    answer: 'Sí. Ninja Planner es 100% web, por lo que tu equipo puede acceder desde cualquier lugar. Las revisiones semanales y el tablero de tareas mantienen a todos alineados sin importar dónde estén.',
  },
];

const STRUCTURED_DATA = [
  buildSoftwareApp({
    name: 'Ninja Planner',
    url: 'https://ninja-planner.com',
    description: 'Planificador de equipo y dashboard empresarial para pymes en México y LATAM.',
    applicationCategory: 'ProductivityApplication',
    // No price: access is through a ninja-stack subscription, not a public free plan
  }),
  buildFAQ(FAQ_ITEMS),
];

const FEATURES = [
  {
    icon: CheckSquare,
    title: 'Tablero de tareas',
    description: 'Tablero Kanban con arrastrar y soltar: pendiente, en progreso, terminado y bloqueado, con prioridad, etiquetas, responsables y fechas de entrega.',
  },
  {
    icon: TrendingUp,
    title: 'Metas de ingresos',
    description: 'Define metas mensuales, trimestrales o anuales y compara lo real contra la meta de un vistazo, para que el equipo siempre sepa cómo va.',
  },
  {
    icon: Map,
    title: 'Roadmap de producto',
    description: 'Lleva cada iniciativa de idea a desarrollo y a producción. Todo el equipo sabe qué sigue y por qué.',
  },
  {
    icon: ClipboardList,
    title: 'Revisión semanal',
    description: 'Un ritual semanal con estructura: logros, bloqueos, enfoque de la próxima semana y un indicador de salud del equipo para detectar el desgaste a tiempo.',
  },
  {
    icon: Users,
    title: 'Dashboard de negocio',
    description: 'Los números clave en un solo lugar: ingresos contra metas, avance de objetivos y carga de trabajo del equipo.',
  },
];

const STATS = [
  { value: '1', label: 'workspace para todo tu equipo' },
  { value: '∞', label: 'tareas e hitos' },
  { value: '0', label: 'hojas de cálculo' },
];

const SUBSCRIPTION_NOTE = 'El acceso requiere una suscripción de ninja-stack.';

export default function Landing() {
  const { isLoaded, isSignedIn } = useAuth();
  // A signed-out deep link (/tasks?task=...) lands here as /?redirect_url=<path>; send the user
  // back there after signing in instead of to the dashboard.
  const [redirectTo] = useState(() => {
    try {
      return safeRedirectPath(new URLSearchParams(window.location.search).get('redirect_url'));
    } catch {
      return null;
    }
  });
  const target = redirectTo ?? '/dashboard';
  // Which Clerk widget the auth overlay shows ("Crear cuenta" goes to sign-up, not sign-in).
  // Opens straight to sign-in when the visitor arrived from a protected link.
  const [authMode, setAuthMode] = useState<'signIn' | 'signUp' | null>(redirectTo ? 'signIn' : null);
  const setSignInOpen = (open: boolean) => setAuthMode(open ? 'signIn' : null);
  const openSignUp = () => setAuthMode('signUp');

  // Auth overlay: Escape closes it, focus moves into it on open and back to the page on close.
  const overlayRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!authMode) return;
    const previous = document.activeElement as HTMLElement | null;
    overlayRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAuthMode(null);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [authMode]);

  if (isLoaded && isSignedIn) return <Redirect to={target} />;

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <SeoHead
        title="Planificador de Equipo y Dashboard Empresarial"
        description="Organiza las tareas, metas, roadmap y métricas de negocio de tu equipo en un solo lugar. Planificador para pymes en México y LATAM."
        canonical="https://ninja-planner.com/"
        structuredData={STRUCTURED_DATA}
      />
      {/* Navbar */}
      <header className="sticky top-0 z-50 border-b bg-background/80 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto flex items-center justify-between px-6 h-14">
          <div className="flex items-center gap-2.5">
            <div className="h-7 w-7 rounded-md bg-primary flex items-center justify-center">
              <Briefcase className="h-4 w-4 text-primary-foreground" />
            </div>
            <span className="font-semibold text-sm tracking-tight">Ninja Planner</span>
          </div>
          <Button size="sm" onClick={() => setSignInOpen(true)}>
            Iniciar sesión
          </Button>
        </div>
      </header>

      {/* Hero */}
      <section className="flex-1 flex flex-col items-center justify-center text-center px-6 py-24 relative overflow-hidden">
        {/* Subtle bg decoration */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-primary/5 rounded-full blur-3xl" />
        </div>

        <div className="relative max-w-3xl mx-auto space-y-6">
          <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-4 py-1.5 text-xs font-medium text-primary">
            <Layers className="h-3 w-3" />
            Planificador de equipo para pymes
          </div>

          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight leading-tight">
            El centro de mando<br />
            <span className="text-primary">de tu equipo.</span>
          </h1>

          <p className="text-lg text-muted-foreground max-w-xl mx-auto leading-relaxed">
            Tareas, metas, roadmap y revisiones semanales en un solo workspace.
            Planea la semana, entrega el trabajo y mide lo que importa.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
            <Button size="lg" className="gap-2 px-8" onClick={openSignUp}>
              Crear cuenta
              <ArrowRight className="h-4 w-4" />
            </Button>
            <Button size="lg" variant="outline" onClick={() => setSignInOpen(true)}>
              Iniciar sesión
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{SUBSCRIPTION_NOTE}</p>
        </div>

        {/* Stats */}
        <div className="relative mt-16 flex flex-col sm:flex-row items-center gap-8 sm:gap-16">
          {STATS.map(({ value, label }) => (
            <div key={label} className="text-center">
              <div className="text-3xl font-bold text-primary">{value}</div>
              <div className="text-sm text-muted-foreground mt-1">{label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Features */}
      <section className="border-t bg-muted/30 px-6 py-20">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-12">
            <div className="flex items-center justify-center gap-2 mb-3">
              <BarChart3 className="h-4 w-4 text-primary" />
              <span className="text-xs font-semibold uppercase tracking-widest text-primary">Hecho para ejecutar</span>
            </div>
            <h2 className="text-2xl sm:text-3xl font-bold">Planea. Entrega. Revisa.</h2>
            <p className="text-muted-foreground mt-3 max-w-lg mx-auto">
              Todo lo que tu equipo necesita para mantenerse alineado, sin la complejidad de las herramientas para grandes corporativos.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {FEATURES.map(({ icon: Icon, title, description }, i) => (
              <div
                key={title}
                className={cn(
                  'rounded-xl border bg-card p-6 space-y-3 hover:border-primary/40 hover:shadow-sm transition-all',
                  i === 4 && 'sm:col-span-2 lg:col-span-1',
                )}
              >
                <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center">
                  <Icon className="h-5 w-5 text-primary" />
                </div>
                <h3 className="font-semibold">{title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ — rendered so the FAQPage structured data matches visible content */}
      <section className="border-t px-6 py-20">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-2xl sm:text-3xl font-bold text-center mb-10">Preguntas frecuentes</h2>
          <div className="space-y-3">
            {FAQ_ITEMS.map(({ question, answer }) => (
              <details key={question} className="group rounded-lg border bg-card px-5 py-4">
                <summary className="cursor-pointer list-none font-medium flex items-center justify-between gap-4">
                  {question}
                  <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
                </summary>
                <p className="mt-3 text-sm text-muted-foreground leading-relaxed">{answer}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* CTA banner */}
      <section className="border-t px-6 py-16">
        <div className="max-w-2xl mx-auto text-center space-y-5">
          <h2 className="text-2xl sm:text-3xl font-bold">Menos cambiar de herramienta. Más avanzar.</h2>
          <p className="text-muted-foreground">
            Ten el workspace de tu equipo listo en minutos.
          </p>
          <Button size="lg" className="gap-2 px-8" onClick={openSignUp}>
            Crear cuenta
            <ArrowRight className="h-4 w-4" />
          </Button>
          <p className="text-xs text-muted-foreground">{SUBSCRIPTION_NOTE}</p>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t px-6 py-6">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <div className="h-5 w-5 rounded bg-primary flex items-center justify-center">
              <Briefcase className="h-3 w-3 text-primary-foreground" />
            </div>
            <span className="font-medium text-foreground">Ninja Planner</span>
          </div>
          <span>© {new Date().getFullYear()} Ninja Planner. Todos los derechos reservados.</span>
        </div>
      </footer>

      {/* Sign-in overlay */}
      {authMode && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 overflow-y-auto"
          onClick={() => setSignInOpen(false)}
        >
          <div
            ref={overlayRef}
            role="dialog"
            aria-modal="true"
            aria-label={authMode === 'signUp' ? 'Crear cuenta' : 'Iniciar sesión'}
            tabIndex={-1}
            className="relative outline-none"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              aria-label="Cerrar"
              onClick={() => setSignInOpen(false)}
              className="absolute -top-3 -right-3 z-10 rounded-full bg-background border shadow-sm h-7 w-7 flex items-center justify-center hover:bg-accent transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
            {authMode === 'signUp' ? (
              <SignUp routing="hash" forceRedirectUrl={target} signInForceRedirectUrl={target} />
            ) : (
              <SignIn routing="hash" forceRedirectUrl={target} signUpForceRedirectUrl={target} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
