import type { SpecialistConsultations } from './specialist-consultations.js';

let active: SpecialistConsultations | undefined;
export function setSpecialistConsultations(service: SpecialistConsultations) {
  if (active) throw Error('Specialist consultation owner already installed');
  active = service;
}
export function getSpecialistConsultations() {
  if (!active) throw Error('Specialist consultations are unavailable on this controller');
  return active;
}
export function closeSpecialistConsultations() {
  active?.closeIdle();
  active = undefined;
}
