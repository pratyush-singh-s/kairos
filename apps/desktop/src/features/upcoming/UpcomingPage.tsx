import type { Route } from "../../app/routes";

/** Clearly-labelled page for a feature that is planned but not built yet. */
export function UpcomingPage(props: { route: Route }) {
  return (
    <section aria-labelledby="upcoming-title">
      <h1 id="upcoming-title" className="page-title">
        {props.route.label}
      </h1>
      <div className="card notice">
        <p>
          <strong>Not built yet.</strong> This page arrives in Phase {props.route.arrivesInPhase}.
        </p>
        <p className="muted">{props.route.summary}</p>
      </div>
    </section>
  );
}
