import { prisma } from '../lib/prisma';
import { fail, ok, ToolResponse } from './toolResponse';

interface FindDoctorsParameters {
  reason?: string | null;
}

/**
 * Surfaces the clinic's doctors so the assistant can present real names
 * before asking the caller for a preference, instead of silently booking
 * against whichever doctor resolveDoctorForClinic() would default to.
 *
 * doctorId values in the response are internal references for chaining into
 * checkAvailability/validateSlot/confirmDetails/bookAppointment — the system
 * prompt instructs the model never to speak them aloud.
 */
export async function findDoctors(
  clinicId: string,
  _callId: string,
  parameters: FindDoctorsParameters
): Promise<ToolResponse> {
  const clinic = await prisma.clinic.findUniqueOrThrow({
    where: { id: clinicId },
    select: { organizationId: true },
  });

  const doctors = await prisma.doctor.findMany({
    where: {
      organizationId: clinic.organizationId,
      status: 'active',
      clinics: { some: { clinicId } },
    },
    select: { id: true, name: true, specialty: true, qualification: true },
    orderBy: { name: 'asc' },
  });

  if (doctors.length === 0) {
    return fail(
      'NO_DOCTORS_AVAILABLE',
      'No doctors are currently configured for this clinic. Apologise to the patient in their current language and offer a staff callback.'
    );
  }

  // A loose relevance signal only, never a filter — the patient must still
  // be able to choose any doctor at the clinic regardless of stated reason.
  const reason = parameters.reason?.trim().toLowerCase();
  const list = doctors
    .map((doctor) => ({
      doctorId: doctor.id,
      name: doctor.name,
      specialty: doctor.specialty,
      qualification: doctor.qualification,
      relevant: Boolean(
        reason && doctor.specialty && doctor.specialty.toLowerCase().includes(reason)
      ),
    }))
    .sort((a, b) => Number(b.relevant) - Number(a.relevant));

  return ok(
    'DOCTORS_FOUND',
    'Tell the patient, in their current language, which doctors are available using data.doctors (speak their name and specialty for each — never speak data.doctorId, it is an internal reference only). If any entries have relevant=true, mention those first as a good match for what they described. Then ask whether they have a preference for a specific doctor, or are happy to see any available doctor. If they name one, remember that doctor\'s doctorId from this response and pass it as the doctorId argument on every subsequent tool call for this booking: checkAvailability, validateSlot, and bookAppointment. If they have no preference, do not pass a doctorId on those calls and proceed with the clinic\'s default scheduling.',
    { doctors: list }
  );
}
