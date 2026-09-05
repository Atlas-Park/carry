export type PreferenceInput = { memberId: string; orderedRoles: string[] };
export type FairMatch = { memberId: string; role: string; rank: number };
export type FairAssignmentResult = {
  matches: FairMatch[];
  worstRank: number;
  rankSum: number;
  optimalCombinationCount: number;
};

function permutations<T>(items: T[]): T[][] {
  if (items.length < 2) return [items];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map(
      (rest) => [item, ...rest],
    ),
  );
}

/** Minimizes the worst assigned rank, then the total rank; randomizes only exact ties. */
export function calculateFairAssignment(
  roles: string[],
  preferences: PreferenceInput[],
  random: () => number = Math.random,
): FairAssignmentResult {
  if (
    roles.length < 2 ||
    roles.length > 8 ||
    roles.length !== preferences.length
  )
    throw new Error("역할과 팀원 수는 2~8명이며 서로 같아야 합니다.");
  let bestWorst = Infinity,
    bestSum = Infinity,
    best: FairMatch[][] = [];
  for (const roleOrder of permutations(roles)) {
    const matches = preferences.map((preference, index) => {
      const role = roleOrder[index],
        found = preference.orderedRoles.indexOf(role);
      return {
        memberId: preference.memberId,
        role,
        rank: found < 0 ? roles.length : found + 1,
      };
    });
    const worst = Math.max(...matches.map((match) => match.rank)),
      sum = matches.reduce((total, match) => total + match.rank, 0);
    if (worst < bestWorst || (worst === bestWorst && sum < bestSum)) {
      bestWorst = worst;
      bestSum = sum;
      best = [matches];
    } else if (worst === bestWorst && sum === bestSum) best.push(matches);
  }
  return {
    matches: best[Math.floor(random() * best.length)],
    worstRank: bestWorst,
    rankSum: bestSum,
    optimalCombinationCount: best.length,
  };
}

export function createRoleDeadlines(
  finalDeadline: string,
  roleCount: number,
  now = Date.now(),
): string[] {
  const end = new Date(finalDeadline).getTime(),
    available = Math.max(end - now, roleCount * 60_000);
  return Array.from({ length: roleCount }, (_, index) =>
    new Date(
      Math.min(end - 60_000, now + available * ((index + 1) / (roleCount + 1))),
    ).toISOString(),
  );
}
