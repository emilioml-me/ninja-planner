import { Link } from 'wouter';
import { ArrowRight, Briefcase, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SeoHead } from '@/components/SeoHead';
import { buildFAQ } from '@/lib/structured-data';

// Public es-MX feature pages (SEO phase C). Only claim what the app actually does: no AI summaries
// (they depend on an Ollama host), no timers (time is logged manually), no free plan.
// The title/description of each page must match FEATURE_PAGES in src/lib/seoMeta.ts (the server
// writes the same tags before React mounts), and every slug must be in client/public/sitemap.xml.

const SITE_URL = 'https://ninja-planner.com';

interface FeatureSection {
  title: string;
  points: string[];
}

interface FeaturePageContent {
  slug: string;
  /** <title> without the " | Ninja Planner" suffix SeoHead adds */
  title: string;
  description: string;
  /** Short name for breadcrumbs and cross-links */
  name: string;
  h1: string;
  intro: string;
  sections: FeatureSection[];
  faq: { question: string; answer: string }[];
}

export const FEATURE_PAGES: FeaturePageContent[] = [
  {
    slug: 'gestion-de-tareas-para-equipos',
    title: 'Gestión de Tareas para Equipos con Tablero Kanban',
    description:
      'Organiza las tareas de tu equipo en un tablero Kanban con responsables, prioridades, fechas, checklists, dependencias y tareas recurrentes. Para pymes en México y LATAM.',
    name: 'Gestión de tareas',
    h1: 'Gestión de tareas para equipos',
    intro:
      'Un tablero compartido donde todo el equipo ve qué está pendiente, quién lo tiene y qué está bloqueado, sin hojas de cálculo ni pendientes perdidos en el chat.',
    sections: [
      {
        title: 'Tablero Kanban',
        points: [
          'Columnas de pendiente, en progreso, terminado y bloqueado, con arrastrar y soltar.',
          'Prioridad, etiquetas, responsable, fecha de inicio y fecha de entrega en cada tarea.',
          'Búsqueda y filtros por prioridad y por tareas vencidas.',
        ],
      },
      {
        title: 'Todo el contexto en cada tarea',
        points: [
          'Checklist, archivos adjuntos y comentarios con @menciones.',
          'Seguidores que reciben avisos cuando la tarea cambia, y un historial de actividad.',
          'Dependencias: marca qué tarea bloquea a otra.',
        ],
      },
      {
        title: 'Vistas para cada persona',
        points: [
          'Mis tareas: solo lo que te toca a ti.',
          'Calendario por fecha de entrega y línea de tiempo tipo Gantt.',
          'Carga de trabajo por persona para repartir mejor.',
        ],
      },
      {
        title: 'Menos trabajo repetitivo',
        points: [
          'Tareas recurrentes diarias, semanales, quincenales o mensuales.',
          'Plantillas de tareas con checklist incluido.',
          'Importación y exportación en CSV, y campos personalizados.',
          'Automatizaciones: al cambiar de estado, al asignar o al vencer una fecha, notifica, reasigna o cambia el estado.',
        ],
      },
    ],
    faq: [
      {
        question: '¿Puedo importar mis tareas desde una hoja de cálculo?',
        answer:
          'Sí. Exporta tu hoja como CSV e impórtala en Ninja Planner, hasta 500 tareas por archivo. También puedes exportar tus tareas a CSV cuando quieras.',
      },
      {
        question: '¿Cómo se entera el equipo de los cambios?',
        answer:
          'Con notificaciones dentro de la app cuando te asignan una tarea, te mencionan en un comentario, comentan una tarea tuya o cambia una tarea que sigues, y por correo cuando te asignan una tarea o se acerca su fecha de entrega.',
      },
      {
        question: '¿Puedo compartir las tareas con alguien que no es del equipo?',
        answer:
          'Sí. Los administradores pueden crear enlaces de invitado de solo lectura, con fecha de vencimiento, para clientes o colaboradores externos.',
      },
    ],
  },
  {
    slug: 'planificacion-de-sprints',
    title: 'Planificación de Sprints con Burndown y Velocidad del Equipo',
    description:
      'Planea sprints, sigue el burndown, mide la velocidad del equipo y cierra cada ciclo con una retrospectiva. Sprints y épicas para equipos de pymes.',
    name: 'Planificación de sprints',
    h1: 'Planificación de sprints',
    intro:
      'Trabaja en ciclos cortos con una meta clara, ve cada día si el sprint va a tiempo y aprende de cada cierre con datos reales.',
    sections: [
      {
        title: 'Sprints con meta y fechas',
        points: [
          'Crea sprints con fecha de inicio, fecha de fin y meta.',
          'Asigna tareas al sprint con sus puntos de historia.',
          'Al cerrar, mueve lo que quedó pendiente al backlog en un clic.',
        ],
      },
      {
        title: 'Burndown y velocidad',
        points: [
          'Gráfica de burndown para ver si el sprint va en ritmo.',
          'Velocidad por sprint: puntos comprometidos al iniciar contra puntos completados.',
          'Capacidad por persona para no sobrecargar a nadie.',
        ],
      },
      {
        title: 'Retrospectivas',
        points: [
          'Qué salió bien, qué mejorar y acciones para el siguiente sprint.',
          'La retrospectiva queda guardada junto al sprint.',
        ],
      },
      {
        title: 'Épicas y plantillas',
        points: [
          'Agrupa tareas de varios sprints en épicas y ve su avance.',
          'Plantillas de sprint y de épica para arrancar ciclos repetitivos más rápido.',
        ],
      },
    ],
    faq: [
      {
        question: '¿Necesito usar Scrum para usar Ninja Planner?',
        answer:
          'No. Los sprints son opcionales: puedes trabajar solo con el tablero de tareas y activar los sprints cuando tu equipo quiera trabajar por ciclos.',
      },
      {
        question: '¿Cómo se calcula la velocidad del equipo?',
        answer:
          'Ninja Planner guarda los puntos de historia comprometidos al iniciar cada sprint y los compara con los puntos de las tareas terminadas al cerrarlo.',
      },
      {
        question: '¿Qué pasa con las tareas que no se terminaron?',
        answer:
          'Al completar el sprint puedes mover las tareas pendientes al backlog para planearlas en el siguiente ciclo.',
      },
    ],
  },
  {
    slug: 'okr-para-pymes',
    title: 'OKR para Pymes: Objetivos y Resultados Clave con tu Equipo',
    description:
      'Define objetivos y resultados clave, liga las tareas y las iniciativas del roadmap y ve el avance real del equipo. OKR sencillos para pymes en México y LATAM.',
    name: 'OKR para pymes',
    h1: 'OKR para pymes',
    intro:
      'Pon por escrito qué quiere lograr la empresa este trimestre, cómo vas a medirlo y qué trabajo lo mueve, sin hojas de cálculo que nadie actualiza.',
    sections: [
      {
        title: 'Objetivos y resultados clave',
        points: [
          'Crea objetivos con resultados clave medibles: valor actual contra meta.',
          'Estados activo, completado y cancelado para cada objetivo.',
        ],
      },
      {
        title: 'Conectados al trabajo diario',
        points: [
          'Liga tareas e iniciativas del roadmap a cada objetivo.',
          'El avance se calcula con el trabajo que realmente se terminó.',
          'Avisos al llegar al 50% y al 100% de un objetivo.',
        ],
      },
      {
        title: 'Visibles para todo el equipo',
        points: [
          'Tablero de OKR en la analítica con el avance de cada objetivo.',
          'Junto a las metas de ingresos y la revisión semanal del equipo.',
        ],
      },
    ],
    faq: [
      {
        question: '¿Qué es un OKR?',
        answer:
          'OKR significa objetivos y resultados clave: un objetivo cualitativo (qué quieres lograr) y de dos a cinco resultados medibles que indican si lo lograste.',
      },
      {
        question: '¿Cuántos objetivos debería tener una pyme?',
        answer:
          'Pocos. Para un equipo pequeño suelen bastar de uno a tres objetivos por trimestre, cada uno con pocos resultados clave, para que el equipo no pierda el enfoque.',
      },
      {
        question: '¿Cómo se mide el avance de un objetivo?',
        answer:
          'Con el valor actual de cada resultado clave frente a su meta y con las tareas e iniciativas ligadas que ya se terminaron.',
      },
    ],
  },
  {
    slug: 'roadmap-de-producto',
    title: 'Roadmap de Producto Compartido con Votos de tus Clientes',
    description:
      'Organiza las iniciativas de idea a desarrollo y a producción, liga las tareas y comparte un roadmap público donde tus clientes pueden votar. Para equipos de producto.',
    name: 'Roadmap de producto',
    h1: 'Roadmap de producto',
    intro:
      'Un solo lugar para decidir qué se construye, en qué orden y por qué, y para mostrarle a tus clientes lo que viene.',
    sections: [
      {
        title: 'De la idea a producción',
        points: [
          'Columnas de idea, en desarrollo, en producción y archivado.',
          'Ordena las iniciativas arrastrándolas según su prioridad.',
          'Liga tareas a cada iniciativa para ver el avance real.',
        ],
      },
      {
        title: 'Roadmap público con votos',
        points: [
          'Comparte un enlace público de tu roadmap.',
          'Tus clientes votan por las iniciativas que más les importan, sin crear una cuenta.',
          'Usa los votos para decidir qué construir primero.',
        ],
      },
      {
        title: 'Conectado a tus objetivos',
        points: [
          'Liga iniciativas a tus OKR para que el roadmap responda a las metas del negocio.',
          'Liga un issue público de GitHub para seguir su estado.',
        ],
      },
    ],
    faq: [
      {
        question: '¿Mis clientes necesitan una cuenta para votar?',
        answer: 'No. Cualquier persona con el enlace del roadmap público puede ver las iniciativas y votar.',
      },
      {
        question: '¿El roadmap público muestra todo?',
        answer: 'Muestra las iniciativas activas; las archivadas no aparecen en el enlace público.',
      },
      {
        question: '¿En qué se diferencia el roadmap del tablero de tareas?',
        answer:
          'El roadmap muestra iniciativas grandes y su prioridad; el tablero muestra el trabajo diario. Ligas las tareas a cada iniciativa para conectar ambos.',
      },
    ],
  },
  {
    slug: 'control-de-horas',
    title: 'Control de Horas por Proyecto y Presupuestos para Equipos',
    description:
      'Registra el tiempo de cada tarea, marca las horas facturables con su tarifa y compara el presupuesto contra lo real. Reporte de horas por persona y periodo.',
    name: 'Control de horas',
    h1: 'Control de horas y presupuestos',
    intro:
      'Sabe cuánto tiempo se fue en cada tarea y proyecto, cuánto vale ese tiempo y si el presupuesto todavía alcanza.',
    sections: [
      {
        title: 'Registro de tiempo por tarea',
        points: [
          'Registra horas y minutos en cada tarea, con una nota.',
          'Marca qué tiempo es facturable.',
          'Los administradores asignan la tarifa por hora.',
        ],
      },
      {
        title: 'Presupuestos contra lo real',
        points: [
          'Presupuestos por periodo con partidas de gasto.',
          'Liga un presupuesto a una épica o a un sprint.',
          'El costo de las horas registradas se suma a lo real automáticamente.',
        ],
      },
      {
        title: 'Reporte de horas',
        points: [
          'Horas por rango de fechas, por persona y por sprint.',
          'Total de horas facturables y su valor.',
        ],
      },
    ],
    faq: [
      {
        question: '¿Ninja Planner funciona como reloj checador?',
        answer:
          'No. El tiempo se registra manualmente en cada tarea; no es un sistema de asistencia ni de entrada y salida.',
      },
      {
        question: '¿Puedo calcular cuánto facturar a un cliente?',
        answer:
          'Sí. Marca el tiempo como facturable y asigna una tarifa por hora; el reporte suma las horas facturables y su valor por periodo. Ninja Planner no emite facturas.',
      },
      {
        question: '¿Quién puede ver las tarifas por hora?',
        answer: 'Los administradores. Los demás miembros solo ven la tarifa de su propio tiempo registrado.',
      },
    ],
  },
];

export default function FeaturePage({ slug }: { slug: string }) {
  const page = FEATURE_PAGES.find((p) => p.slug === slug);
  if (!page) return null;

  const url = `${SITE_URL}/${page.slug}`;
  const structuredData = [
    buildFAQ(page.faq),
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Inicio', item: `${SITE_URL}/` },
        { '@type': 'ListItem', position: 2, name: page.name, item: url },
      ],
    },
  ];
  const related = FEATURE_PAGES.filter((p) => p.slug !== page.slug);

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <SeoHead title={page.title} description={page.description} canonical={url} structuredData={structuredData} />

      <header className="sticky top-0 z-50 border-b bg-background/80 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto flex items-center justify-between px-6 h-14">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="h-7 w-7 rounded-md bg-primary flex items-center justify-center">
              <Briefcase className="h-4 w-4 text-primary-foreground" />
            </div>
            <span className="font-semibold text-sm tracking-tight">Ninja Planner</span>
          </Link>
          <Button size="sm" asChild>
            <a href="/?acceso=iniciar">Iniciar sesión</a>
          </Button>
        </div>
      </header>

      <main className="flex-1">
        <section className="px-6 pt-10 pb-16">
          <div className="max-w-3xl mx-auto space-y-6">
            <nav aria-label="Ruta de navegación" className="text-xs text-muted-foreground">
              <Link href="/" className="hover:text-foreground">Inicio</Link>
              <span className="mx-1.5">/</span>
              <span>{page.name}</span>
            </nav>
            <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight leading-tight">{page.h1}</h1>
            <p className="text-lg text-muted-foreground leading-relaxed">{page.intro}</p>
            <div className="flex flex-col sm:flex-row gap-3 pt-2">
              <Button size="lg" className="gap-2 px-8" asChild>
                <a href="/?acceso=registro">
                  Crear cuenta
                  <ArrowRight className="h-4 w-4" />
                </a>
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">El acceso requiere una suscripción de ninja-stack.</p>
          </div>
        </section>

        <section className="border-t bg-muted/30 px-6 py-16">
          <div className="max-w-5xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-5">
            {page.sections.map((section) => (
              <div key={section.title} className="rounded-xl border bg-card p-6 space-y-3">
                <h2 className="font-semibold text-lg">{section.title}</h2>
                <ul className="space-y-2">
                  {section.points.map((point) => (
                    <li key={point} className="flex gap-2 text-sm text-muted-foreground leading-relaxed">
                      <Check className="h-4 w-4 shrink-0 text-primary mt-0.5" />
                      <span>{point}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        {/* FAQ: rendered so the FAQPage structured data matches visible content */}
        <section className="border-t px-6 py-16">
          <div className="max-w-3xl mx-auto">
            <h2 className="text-2xl sm:text-3xl font-bold text-center mb-8">Preguntas frecuentes</h2>
            <div className="space-y-3">
              {page.faq.map(({ question, answer }) => (
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

        <section className="border-t px-6 py-12">
          <div className="max-w-5xl mx-auto">
            <h2 className="text-lg font-semibold mb-4">Más funciones de Ninja Planner</h2>
            <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {related.map((p) => (
                <li key={p.slug}>
                  <Link
                    href={`/${p.slug}`}
                    className="flex items-center justify-between gap-2 rounded-lg border bg-card px-4 py-3 text-sm hover:border-primary/40 transition-colors"
                  >
                    {p.name}
                    <ArrowRight className="h-4 w-4 text-muted-foreground" />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>

      <footer className="border-t px-6 py-6">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-muted-foreground">
          <Link href="/" className="font-medium text-foreground">Ninja Planner</Link>
          <span>© {new Date().getFullYear()} Ninja Planner. Todos los derechos reservados.</span>
        </div>
      </footer>
    </div>
  );
}
