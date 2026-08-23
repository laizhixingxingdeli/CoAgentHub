/** Participant row shape returned by GET /api/participants. */
type ParticipantSummary = {
  id: string;
  name: string;
};

const LOCAL_USER_NAME = "Local User";

/** Find the server-created Local User without persisting an identity locally. */
export function findLocalUserParticipantId(
  participants: readonly ParticipantSummary[],
): string | undefined {
  return participants.find(
    (participant) => participant.name === LOCAL_USER_NAME,
  )?.id;
}

/** Read the Local User id through the existing participant roster endpoint. */
export async function fetchLocalUserParticipantId(): Promise<
  string | undefined
> {
  const response = await fetch("/api/participants");
  if (!response.ok) {
    return undefined;
  }
  const participants = (await response.json()) as ParticipantSummary[];
  return findLocalUserParticipantId(participants);
}
