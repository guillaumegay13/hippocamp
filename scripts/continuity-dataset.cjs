const fs = require("node:fs/promises");
const path = require("node:path");

// Words that would tell the agent to go look at memory. Recall must be autonomous.
const HINT_PATTERN =
  /\b(remember|recall|memory|memories|(your|my|the) notes|last (session|time)|previous(ly)?|as (we|i) (said|discussed|agreed)|earlier session)\b/i;

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function loadDataset(dir) {
  const facts = await readJson(path.join(dir, "facts.json"));
  const timeline = await readJson(path.join(dir, "timeline.json"));
  const sessions = new Map();
  const seeds = {};
  const scenariosDir = path.join(dir, "scenarios");

  for (const project of (await fs.readdir(scenariosDir)).sort()) {
    const sessionsFile = path.join(scenariosDir, project, "sessions.json");

    for (const session of await readJson(sessionsFile)) {
      sessions.set(session.id, session);
    }

    seeds[project] = path.join(scenariosDir, project, "seed");
  }

  return { facts, sessions, timeline, seeds };
}

function factDistance(timeline, fact, probeId) {
  return timeline.indexOf(probeId) - timeline.indexOf(fact.plantedIn);
}

function validateDataset({ facts, sessions, timeline }) {
  const errors = [];
  const factsById = new Map(facts.map((fact) => [fact.id, fact]));
  const position = new Map();

  timeline.forEach((id, index) => {
    if (position.has(id)) {
      errors.push(`${id} appears twice in the timeline`);
    } else {
      position.set(id, index);
    }

    if (!sessions.has(id)) {
      errors.push(`timeline lists unknown session ${id}`);
    }
  });

  for (const session of sessions.values()) {
    if (!position.has(session.id)) {
      errors.push(`${session.id} is missing from the timeline`);
    }

    session.turns.forEach((turn, index) => {
      if (HINT_PATTERN.test(turn)) {
        errors.push(`${session.id} turn ${index + 1} has a retrieval hint: "${turn.match(HINT_PATTERN)[0]}"`);
      }
    });

    for (const id of session.plants) {
      if (!factsById.has(id)) {
        errors.push(`${session.id} plants unknown fact ${id}`);
      }
    }
  }

  for (const fact of facts) {
    const planter = sessions.get(fact.plantedIn);

    if (!planter || !planter.plants.includes(fact.id)) {
      errors.push(`${fact.id} plantedIn ${fact.plantedIn}, but that session does not list it in plants`);
    }

    if (fact.supersededBy) {
      const next = factsById.get(fact.supersededBy);

      if (!next) {
        errors.push(`${fact.id} supersededBy unknown fact ${fact.supersededBy}`);
      } else if (position.get(next.plantedIn) < position.get(fact.plantedIn)) {
        errors.push(`${fact.id} supersededBy ${next.id}, which is planted earlier`);
      }
    }
  }

  for (const session of sessions.values()) {
    for (const item of session.checklist) {
      const fact = factsById.get(item.fact);

      if (!fact) {
        errors.push(`${item.id} checks unknown fact ${item.fact}`);
        continue;
      }

      if (!(position.get(fact.plantedIn) < position.get(session.id))) {
        errors.push(`${item.id} checks ${fact.id}, which is not planted before ${session.id}`);
      }

      if (fact.supersededBy) {
        errors.push(`${item.id} checks ${fact.id}, which is superseded by ${fact.supersededBy}`);
      }

      if (item.leak && (fact.project === session.project || fact.project === "shared")) {
        errors.push(`${item.id} is a leak check but ${fact.id} belongs to ${fact.project}`);
      }
    }
  }

  return errors;
}

module.exports = { HINT_PATTERN, factDistance, loadDataset, validateDataset };
