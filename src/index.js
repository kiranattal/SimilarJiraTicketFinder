// Semantic + TF-IDF Similarity Plugin Resolver
// This resolver handles fetching Jira issues, computing similarity using SBERT (semantic) and TF-IDF (lexical),
// and returning the top N similar issues.

import Resolver from '@forge/resolver';
import api, { route, fetch } from '@forge/api';
import weights from './config';
import { phraseMap, normalizationDictionary } from './normalizationDictionary';

const SEMANTIC_WEIGHT = weights['semantic_weight'];
const TFIDF_WEIGHT = weights['tf_idf_weight'];
const SEMANTIC_THRESHOLD = weights['semantic_threshold'];
const SUMMARY_WEIGHT = weights['summary-weightage'];
const DESCRIPTION_WEIGHT = weights['description-weightage'];
const MAX_BOOST=weights["max_boost"]
const BOOST_ISSUETYPE_MATCH = weights["boost_issuetype_match"]
const BOOST_LABELS_OVERLAP = weights["boost_labels_overlap"]
const BOOST_COMPONENTS_OVERLAP = weights["boost_components_overlap"]


const STOP_WORDS = new Set([
  'the', 'is', 'in', 'at', 'of', 'a', 'and', 'to', 'it', 'for',
  'on', 'this', 'that', 'with', 'as', 'by', 'an'
]);

// --- Text Preprocessing ---
function normalizeToken(token) {
  return normalizationDictionary[token] || token;
}

function applyPhraseMap(text) {
  for (const [phrase, replacement] of Object.entries(phraseMap)) {
    text = text.replace(new RegExp(`\\b${phrase}\\b`, 'gi'), replacement);
  }
  return text;
}

function tokenize(text) {
  const normalized = applyPhraseMap(text || '').toLowerCase();
  return normalized
    .split(/\W+/)
    .map(normalizeToken)
    .filter(t => t && !STOP_WORDS.has(t));
}

// --- TF-IDF Cosine Similarity Logic ---
function computeDocumentFrequencies(documents) {
  const df = {};
  for (const tokens of documents) {
    for (const token of new Set(tokens)) {
      df[token] = (df[token] || 0) + 1;
    }
  }
  return df;
}

function computeTfIdf(tokens, df, totalDocs) {
  const tf = {};
  const total = tokens.length;
  for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
  for (const t in tf) {
    tf[t] = (tf[t] / total) * Math.log(totalDocs / (df[t] || 1));
  }
  return tf;
}

function cosineSimilarity(tf1, tf2) {
  const terms = new Set([...Object.keys(tf1), ...Object.keys(tf2)]);
  let dot = 0, mag1 = 0, mag2 = 0;
  for (const term of terms) {
    const a = tf1[term] || 0;
    const b = tf2[term] || 0;
    dot += a * b;
    mag1 += a * a;
    mag2 += b * b;
  }
  return dot / (Math.sqrt(mag1) * Math.sqrt(mag2) || 1);
}



export function calculateTFIDFCosineSimilarity(current, others) {
  const all = [current, ...others];

  const summaries = all.map(doc => tokenize(doc.summary));
  const descriptions = all.map(doc => tokenize(doc.description || ''));

  const summaryDf = computeDocumentFrequencies(summaries);
  const descDf = computeDocumentFrequencies(descriptions);

  const totalDocs = all.length;
  const tfidfSummaries = summaries.map(t => computeTfIdf(t, summaryDf, totalDocs));
  const tfidfDescriptions = descriptions.map(t => computeTfIdf(t, descDf, totalDocs));

  const currentSummaryTfIdf = tfidfSummaries[0];
  const currentDescTfIdf = tfidfDescriptions[0];

  const results = [];
  for (let i = 1; i < all.length; i++) {
    const key = all[i].key;
    const summaryScore = cosineSimilarity(currentSummaryTfIdf, tfidfSummaries[i]);
    const descScore = cosineSimilarity(currentDescTfIdf, tfidfDescriptions[i]);
    const score = summaryScore * SUMMARY_WEIGHT + descScore * DESCRIPTION_WEIGHT;
    results.push({ key, score });
  }
  return results;
}

// --- Semantic Similarity via Remote SBERT API ---
async function fetchSemanticSimilarity(current, others) {
  const payload = { current, others };
  try {
    const res = await fetch('https://sbert-similarity-service.fly.dev/similarity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      console.error('Semantic API error:', res.status, await res.text());
      return {};
    }

    const result = await res.json();
    return result.reduce((map, { key, score }) => {
      map[key] = score;
      return map;
    }, {});
  } catch (error) {
    console.error('Semantic API call failed:', error);
    return {};
  }
}

export async function calculateSemanticSimilarity(current, others) {
  const currentSummary = { key: current.key, text: current.summary };
  const currentDescription = { key: current.key, text: current.description || '' };

  const othersSummary = others.map(issue => ({ key: issue.key, text: issue.summary }));
  const othersDescription = others.map(issue => ({ key: issue.key, text: issue.description || '' }));

  const summaryScores = await fetchSemanticSimilarity(currentSummary, othersSummary);
  const descriptionScores = await fetchSemanticSimilarity(currentDescription, othersDescription);

  return others.map(issue => {
    const key = issue.key;
    const summaryScore = summaryScores[key] || 0;
    const descScore = descriptionScores[key] || 0;
    const score = summaryScore * SUMMARY_WEIGHT + descScore * DESCRIPTION_WEIGHT;
    return { key, score };
  });
}

export function mergeSimilarityScores(semanticScored, tfidfScored) {
  return semanticScored.map(({ key, score: semanticScore }) => {
    const tfidfScore = tfidfScored.find(e => e.key === key)?.score || 0;
    const score = semanticScore >= SEMANTIC_THRESHOLD
      ? semanticScore
      : semanticScore * SEMANTIC_WEIGHT + tfidfScore * TFIDF_WEIGHT;
    return { key, score };
  });
}
export function applyBoostingLogic(currentMetadata, othersMetadata, baseScored) {

  return baseScored.map(({ key, score }) => {
    const issueMeta = othersMetadata.find(i => i.key === key);
    if (!issueMeta) return { key, score }; // fallback

    let boost = 0;

    // 1. Issue type match
    if (issueMeta.issuetype?.id === currentMetadata.issuetype?.id) {
      boost += BOOST_ISSUETYPE_MATCH;
    }

    // 2. Labels match (per overlap)
    const currentLabels = new Set(currentMetadata.labels || []);
    const otherLabels = new Set(issueMeta.labels || []);
    for (const label of currentLabels) {
      if (otherLabels.has(label)) boost += BOOST_LABELS_OVERLAP;
    }

    // 3. Components match (per overlap)
    const currentComponents = new Set((currentMetadata.components || []).map(c => c.name));
    const otherComponents = new Set((issueMeta.components || []).map(c => c.name));
    for (const comp of currentComponents) {
      if (otherComponents.has(comp)) boost += BOOST_COMPONENTS_OVERLAP;
    }

    // 4. Cap the boost to avoid inflation
    boost = Math.min(boost, MAX_BOOST);
    console.log(`Boost for ${key}: ${boost.toFixed(2)}, base: ${score.toFixed(2)}, final: ${Math.min(score + boost, 1).toFixed(2)}`);


    return {
      key,
      score: score + boost
    };
  });
}

// --- Forge Resolver ---
const resolver = new Resolver();

resolver.define('fetchIssues', async ({ context }) => {
  const key = context.extension.issue.key;

  // 1. Fetch current issue
  const res = await api.asApp().requestJira(route`/rest/api/3/issue/${key}`);
  const issueData = await res.json();

  const current = {
    key,
    summary: issueData.fields.summary,
    description: issueData.fields.description?.content?.[0]?.content?.[0]?.text || ''
  };

  // 2. Fetch all other issues from same project
  const project = issueData.fields.project.key;
  const jql = `project = "${project}" AND key != "${key}" ORDER BY updated DESC`;

  let startAt = 0, all = [], total = 0;
  do {
    const sr = await api.asApp().requestJira(route`/rest/api/3/search?jql=${jql}&startAt=${startAt}&maxResults=50`);
    const sd = await sr.json();
    total = sd.total;
    all.push(...sd.issues);
    startAt += 50;
  } while (startAt < total);

  const others = all.map(issue => ({
    key: issue.key,
    summary: issue.fields.summary,
    description: issue.fields.description?.content?.[0]?.content?.[0]?.text || ''
  }));

  const othersMetadata = all.map(issue => ({
  key: issue.key,
  issuetype: issue.fields?.issuetype,
  labels: issue.fields?.labels || [],
  components: issue.fields?.components || []
}));

const currentMetadata = {
  issuetype: issueData.fields?.issuetype,
  labels: issueData.fields?.labels || [],
  components: issueData.fields?.components || []
};

  // 3. Compute similarity
const semanticScored = await calculateSemanticSimilarity(current, others);
const tfidfScored = calculateTFIDFCosineSimilarity(current, others);
const semantic_tfidf_weighted_Scored = mergeSimilarityScores(semanticScored, tfidfScored);

const boosted_Scored = applyBoostingLogic(
  currentMetadata,
  othersMetadata,
  semantic_tfidf_weighted_Scored
);

// 4. Attach metadata (summary + description) and cap score to max 1
const similarityScored = boosted_Scored.map(({ key, score }) => {
  const issue = others.find(i => i.key === key) || {};
  return {
    key,
    summary: issue.summary || '',
    description: issue.description || '',
    score: Math.min(Math.round(score * 100) / 100, 1) // cap score to 1
  };
});


  // 5. Return top 10 sorted results
  similarityScored.sort((a, b) => b.score - a.score);
  return {
    current,
    similar: similarityScored.slice(0, 10)
  };
});
// Add this resolver definition
resolver.define('fetchBaseUrl', async () => {
  const response = await api.asApp().requestJira(route`/rest/api/3/serverInfo`);
  const data = await response.json();
  return data.baseUrl; // e.g. "https://attalkiran.atlassian.net"
});
export const handler = resolver.getDefinitions();
