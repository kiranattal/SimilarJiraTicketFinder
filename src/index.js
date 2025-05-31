import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import weights from './config';

// Load weights from configuration for the different components contributing to similarity
const SUMMARY_WEIGHT = weights["summary-weightage"];
const DESCRIPTION_WEIGHT = weights["description-weightage"];
const COSINE_WEIGHT = weights["cosine-weightage"];
const SIMILARITY_THRESHOLD=weights["similarity-threshold"]

// Forge Resolver handles function invocations from the UI or other extensions
const resolver = new Resolver();

// Stopwords commonly used in English (excluded from analysis)
const STOP_WORDS = new Set([
  'the', 'is', 'in', 'at', 'of', 'a', 'and', 'to', 'it', 'for', 'on', 'this', 'that', 'with', 'as', 'by', 'an'
]);

// Helper function to tokenize text into individual lowercase words, removing stopwords
function tokenize(text) {
  return text
    .toLowerCase()
    .split(/\W+/)
    .filter(token => token && !STOP_WORDS.has(token));
}

// Computes Document Frequency (DF) for each token across all documents
function computeDocumentFrequencies(docs) {
  const df = {};
  for (const tokens of docs) {
    const uniqueTokens = new Set(tokens);
    for (const token of uniqueTokens) {
      df[token] = (df[token] || 0) + 1;
    }
  }
  return df;
}
// Computes TF-IDF vector for a document
function computeTfIdf(tokens, df, totalDocs) {
  const tf = {};
  const totalTokens = tokens.length;

  for (const token of tokens) {
    tf[token] = (tf[token] || 0) + 1;
  }
  for (const token in tf) {
    const termFreq = tf[token] / totalTokens;
    const docFreq = df[token] || 1;
    tf[token] = termFreq * Math.log(totalDocs / docFreq);
  }
  return tf;
}

// Computes Cosine Similarity between two TF-IDF vectors
function cosineSimilarity(tf1, tf2) {
  const allTerms = new Set([...Object.keys(tf1), ...Object.keys(tf2)]);
  let dot = 0, mag1 = 0, mag2 = 0;

  for (const term of allTerms) {
    const v1 = tf1[term] || 0;
    const v2 = tf2[term] || 0;
    dot += v1 * v2;
    mag1 += v1 * v1;
    mag2 += v2 * v2;
  }

  return dot / (Math.sqrt(mag1) * Math.sqrt(mag2) || 1);
}

// Applies additional similarity "boost" based on metadata heuristics like labels/components
function applyHeuristics(issueA, issueB) {
  let boost = 0;
  const tokensA = tokenize(issueA.summary);
  const tokensB = tokenize(issueB.summary);

  // Boost if both issues have same type
  if (issueA.issueType === issueB.issueType) boost += 0.1;

  // Boost if there is label overlap
  const labelsA = issueA.labels || [];
  const labelsB = issueB.labels || [];
  if (labelsA.some(label => labelsB.includes(label))) boost += 0.1;

  // Boost if there is component overlap
  const compA = issueA.components || [];
  const compB = issueB.components || [];
  if (compA.some(c => compB.includes(c))) boost += 0.1;

  return boost;
}

// ==========================
// Core Resolver Functionality
// ==========================

resolver.define('fetchIssues', async ({ context }) => {
  const currentIssueKey = context.extension.issue?.key;

  // Fetch current issue data
  const res = await api.asApp().requestJira(route`/rest/api/3/issue/${currentIssueKey}`);
  const data = await res.json();

  const currentIssue = {
    key: currentIssueKey,
    summary: data.fields.summary || '',
    description: data.fields.description?.content?.[0]?.content?.[0]?.text || '',
    issueType: data.fields.issuetype.name,
    labels: data.fields.labels,
    components: (data.fields.components || []).map(c => c.name)
  };

  // Prepare JQL to fetch all other issues in the same project
  const projectKey = data.fields.project.key;
  const jql = `project = "${projectKey}" AND key != "${currentIssueKey}" ORDER BY updated DESC`;

  // Paginated fetching of all issues
  let startAt = 0;
  let allIssues = [];
  let total = 0;

  do {
    const searchRes = await api.asApp().requestJira(
      route`/rest/api/3/search?jql=${jql}&startAt=${startAt}&maxResults=50`
    );
    const searchData = await searchRes.json();
    total = searchData.total;
    allIssues = allIssues.concat(searchData.issues);
    startAt += 50;
  } while (startAt < total);

  // Tokenize summaries and descriptions for all issues
  const tokenizedSummaries = allIssues.map(issue => tokenize(issue.fields.summary || ''));
  const tokenizedDescriptions = allIssues.map(issue => tokenize(issue.fields.description?.content?.[0]?.content?.[0]?.text || ''));

  // Tokenize current issue for comparison
  const summaryTokensCurrent = tokenize(currentIssue.summary);
  const descTokensCurrent = tokenize(currentIssue.description);

  // Add current issue to the end of the list for DF computation
  tokenizedSummaries.push(summaryTokensCurrent);
  tokenizedDescriptions.push(descTokensCurrent);

  // Compute document frequencies across all issues (including current)
  const dfSummary = computeDocumentFrequencies(tokenizedSummaries);
  const dfDesc = computeDocumentFrequencies(tokenizedDescriptions);

  const totalDocs = tokenizedSummaries.length;

  // Compute TF-IDF for current issue
  const tfidfSummaryCurrent = computeTfIdf(summaryTokensCurrent, dfSummary, totalDocs);
  const tfidfDescCurrent = computeTfIdf(descTokensCurrent, dfDesc, totalDocs);

  // Score each issue against current issue
  const scoredIssues = allIssues.map((issue, idx) => {
    const summary = issue.fields.summary || '';
    const description = issue.fields.description?.content?.[0]?.content?.[0]?.text || '';
    const issueObj = {
      key: issue.key,
      summary,
      description,
      issueType: issue.fields.issuetype?.name,
      labels: issue.fields.labels,
      components: (issue.fields.components || []).map(c => c.name)
    };

    // Compute TF-IDF vectors for the issue
    const summaryTokensIssue = tokenizedSummaries[idx];
    const descTokensIssue = tokenizedDescriptions[idx];
    const tfidfSummaryIssue = computeTfIdf(summaryTokensIssue, dfSummary, totalDocs);
    const tfidfDescIssue = computeTfIdf(descTokensIssue, dfDesc, totalDocs);

    // Compute similarity scores
    const summarySimilarity = cosineSimilarity(tfidfSummaryCurrent, tfidfSummaryIssue);

    let descSimilarity = 0;
    if (descTokensCurrent.length > 0 && descTokensIssue.length > 0) {
      descSimilarity = cosineSimilarity(tfidfDescCurrent, tfidfDescIssue);
    }

    // Compute weighted cosine score
    let weightedCosineScore = 0;
    if (descSimilarity === 0) {
      weightedCosineScore = summarySimilarity;
    } else {
      weightedCosineScore = SUMMARY_WEIGHT * summarySimilarity + DESCRIPTION_WEIGHT * descSimilarity;
    }

    // Apply boost heuristics
    const boost = applyHeuristics(currentIssue, issueObj);

    // Final score is adjusted if above a similarity threshold
    const finalScore = weightedCosineScore >= SIMILARITY_THRESHOLD
      ? Math.min(1, weightedCosineScore + boost)
      : weightedCosineScore;

    return {
      ...issueObj,
      score: finalScore
    };
  });

  // Sort results by descending similarity score
  scoredIssues.sort((a, b) => b.score - a.score);

  return {
    current: currentIssue,
    similar: scoredIssues.slice(0, 10) // Return top 10 similar issues
  };
});

// Export resolver definitions for Forge runtime
export const handler = resolver.getDefinitions();
