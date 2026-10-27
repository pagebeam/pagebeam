import type { TourJourney } from '@pagebeam/core';

export function navigationPath(value: string): string {
  return new URL(value, 'http://pagebeam.invalid').pathname;
}

export function checkpointRoutes(journey: TourJourney): string[] {
  const routes: string[] = [];
  let navigated: string | undefined;
  for (const step of journey.steps) {
    if ('goto' in step) navigated = navigationPath(step.goto);
    if ('shot' in step) {
      const route = step.shot.route ?? navigated;
      if (route) routes.push(route);
    }
  }
  return routes;
}
