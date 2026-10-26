import type { TourJourney } from '@pagebeam/core';

export function selectViewports(journey: TourJourney, requested: string[] = ['desktop']): TourJourney['viewports'] {
  if (!requested.length || !requested.every(name => typeof name === 'string' && name.length)) throw new Error('request at least one viewport');
  if (requested.includes('all')) {
    if (requested.length !== 1) throw new Error('choose all viewports or named viewports, not both');
    return journey.viewports;
  }
  for (const name of requested) {
    if (!journey.viewports.some(viewport => viewport.name === name)) throw new Error(`viewport ${name} is not configured; request a configured viewport explicitly`);
  }
  return journey.viewports.filter(viewport => requested.includes(viewport.name));
}
