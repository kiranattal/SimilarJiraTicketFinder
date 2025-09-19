// Config file specifying weightages used in similarity computation.
// These parameters help fine-tune how similarity scores between Jira issues are calculated.
module.exports = {
  // Importance of issue summary in scoring is higher
  // as summary often contains a concise overview of the issue,
  // making it a strong indicator for duplicate detection.
  "summary-weightage": 0.8,

  // Importance of issue description in scoring is lower than summary weight
  // as descriptions may include more verbose context or unrelated details.
  // Still useful for capturing additional semantic relevance.
  "description-weightage": 0.2,

  // This value determines the minimum cosine similarity score required before
  // applying any heuristic-based boosting. Helps avoid false positives.
  // Also used as a cutoff to filter and return only the top similar issues
  // with a similarity score above this threshold in the final results.
  "similarity-threshold": 0.5,

  "semantic_weight" : 0.8,
   "tf_idf_weight" : 0.2,
   "semantic_threshold" : 0.6,
   "max_boost" : 0.1,
  "boost_issuetype_match" :0.05,
"boost_labels_overlap" :0.02,
"boost_components_overlap" :0.02

};
