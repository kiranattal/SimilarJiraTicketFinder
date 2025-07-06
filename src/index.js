import Resolver from '@forge/resolver';
import api, { route, fetch } from '@forge/api';
import weights from './config';

const SEMANTIC_WEIGHT = 0.8;
const TFIDF_WEIGHT = 1 - SEMANTIC_WEIGHT;
const SEMANTIC_THRESHOLD = 0.6;
const SIMILARITY_THRESHOLD = weights["similarity-threshold"];

 const SUMMARY_WEIGHT = weights["summary-weightage"];
 const DESCRIPTION_WEIGHT = weights["description-weightage"];


  // Importance of issue description in scoring is lower than summary weight
  // as descriptions may include more verbose context or unrelated details.
  // Still useful for capturing additional semantic relevance.


const resolver = new Resolver();


async function fetchSemanticSimilarity(current, others) {
  const payload = {
    current,
    others
  };

  try {
    const res = await fetch('https://sbert-similarity-service.fly.dev/similarity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error('Non-200 response from semantic API:', res.status, errorText);
      return {};
    }

    const result = await res.json();
    console.log('Semantic similarity scores:', result);

    return result.reduce((map, { key, score }) => {
      map[key] = score;
      return map;
    }, {});

  } catch (error) {
    console.error('Semantic API call failed:', error);
    return {};
  }
}

resolver.define('fetchIssues', async ({ context }) => {
  const key = context.extension.issue.key;

  // 1. Fetch current issue
  const r = await api.asApp().requestJira(route`/rest/api/3/issue/${key}`);
  const d = await r.json();

  const currentTextSummary = `${d.fields.summary}`;
  const currentTextDescription =  `${d.fields.description?.content?.[0]?.content?.[0]?.text || ''}`;
  const currentSummary = { key, text: currentTextSummary };
  const currentDescription = { key, text: currentTextDescription };
  const current = {
      key: key,
      summary: d.fields.summary,
      description: d.fields.description?.content?.[0]?.content?.[0]?.text || ''
      };


  // 2. Fetch other issues from same project
  const project = d.fields.project.key;
  const jql = `project="${project}" AND key!="${key}" ORDER BY updated DESC`;

  let startAt = 0, all = [], total = 0;
  do {
    const sr = await api.asApp().requestJira(route`/rest/api/3/search?jql=${jql}&startAt=${startAt}&maxResults=50`);
    const sd = await sr.json();
    total = sd.total;
    all.push(...sd.issues);
    startAt += 50;
  } while (startAt < total);

  // 3. Prepare payload for similarity API
  const othersSummary = all.map(issue => ({
    key: issue.key,
    text: `${issue.fields.summary}`
  }));
  const othersDescription = all.map(issue => ({
    key: issue.key,
    text: `${issue.fields.description?.content?.[0]?.content?.[0]?.text || ''}`
  }));

  const semanticScoresSummary = await fetchSemanticSimilarity(currentSummary, othersSummary);
  const semanticScoresDescription = await fetchSemanticSimilarity(currentDescription, othersDescription);

  // 4. Combine and score
  const scored = all.map(issue => {
    const sid = issue.key;
    const semSummary = semanticScoresSummary[sid] || 0;
    const semDescription=semanticScoresDescription[sid] || 0;

    let sem = semSummary * SUMMARY_WEIGHT + semDescription * DESCRIPTION_WEIGHT

    let combined;
    if (sem >= SEMANTIC_THRESHOLD) {
      combined = sem;
    } else {
      combined = sem * SEMANTIC_WEIGHT; // or blend TF-IDF if needed
    }

    return {
      key: sid,
      summary: issue.fields.summary,
      description: issue.fields.description?.content?.[0]?.content?.[0]?.text || '',
      score: combined
    };
  });

  // 5. Sort & return
  scored.sort((a, b) => b.score - a.score);
  return {
    current: current,
    similar: scored.slice(0, 10)
  };
});

export const handler = resolver.getDefinitions();
