import React, { useEffect, useState } from 'react';
import { events, invoke } from '@forge/bridge';

function App() {
  // State to hold the current Jira issue in context
  const [currentIssue, setCurrentIssue] = useState(null);
  // State to hold the list of similar issues returned from backend
  const [similarIssues, setSimilarIssues] = useState([]);
  // State to hold the Jira base URL (resolver provides this)
  const [jiraBaseUrl, setJiraBaseUrl] = useState('');

  // Function to fetch current issue + similar issues from backend resolver
  const fetchData = async () => {
    const { current, similar } = await invoke('fetchIssues');
    setCurrentIssue(current);
    setSimilarIssues(similar || []);
  };

  // Function to fetch the Jira base URL from resolver
  const fetchBaseUrl = async () => {
    const baseUrl = await invoke('fetchBaseUrl'); // resolver.js must provide this
    setJiraBaseUrl(baseUrl);
  };

  // Run on component mount and when Jira issue context changes
  useEffect(() => {
    fetchData();
    fetchBaseUrl();

    // Subscribe to Jira issue change events
    const unsubscribe = events.on('JIRA_ISSUE_CHANGED', () => {
      fetchData();
    });

    return () => unsubscribe && unsubscribe();
  }, []);

  // If current issue not yet loaded → show loading state
  if (!currentIssue) return <div className="p-4 text-gray-500">Loading...</div>;

  return (
    <div className="p-6 max-w-2xl mx-auto">
      {/* Section: Current Issue */}
      <div className="mb-6">
        <h3 className="text-xl font-semibold text-gray-800 mb-2">Current Issue</h3>
        <div className="p-4 rounded-2xl shadow bg-white border border-gray-200">
          <p className="text-gray-700">
            <strong className="text-indigo-600">{currentIssue.key}</strong>: {currentIssue.summary}
          </p>
        </div>
      </div>

      {/* Section: Similar Issues */}
      <h4 className="text-lg font-semibold text-gray-800 mb-3">Top Similar Issues</h4>

      {similarIssues.length > 0 ? (
        <div className="space-y-4">
          {similarIssues.map((issue, index) => (
            <div
              key={issue.key}
              className="p-4 rounded-2xl shadow bg-white border border-gray-100 hover:shadow-md transition"
            >
              <div className="flex items-center justify-between mb-1">
                <a
                  href={`${jiraBaseUrl}/browse/${issue.key}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-indigo-600 font-bold hover:underline"
                >
                  {index + 1}. {issue.key}
                </a>
                <p className="text-gray-700">{issue.summary}</p>
                <span className="text-sm text-gray-500">
                  Score: {issue.score?.toFixed(2) ?? 'N/A'}
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-gray-500">No similar issues found.</p>
      )}
    </div>
  );
}

export default App;
