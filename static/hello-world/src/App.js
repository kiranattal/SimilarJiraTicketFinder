import React, { useEffect, useState } from 'react';
//Forge APIs to interact with backend and listen to events
import { events, invoke } from '@forge/bridge';

function App() {
  // State to store the currently selected Jira issue
  const [currentIssue, setCurrentIssue] = useState(null);
  // State to store the list of top similar issues
  const [similarIssues, setSimilarIssues] = useState([]);

  // Async function to fetch current issue and similar issues from backend resolver
  const fetchData = async () => {
    // Invoke the backend 'fetchIssues' function
    const { current, similar } = await invoke('fetchIssues');
    // Update state with current issue data
    setCurrentIssue(current);
    // Update state with similar issues or empty array if none
    setSimilarIssues(similar || []);
  };

  useEffect(() => {
    // Initial data fetch when component mounts
    fetchData();

    // Listen to changes in Jira issue context and refetch data accordingly
    const unsubscribe = events.on('JIRA_ISSUE_CHANGED', () => {
      fetchData();
    });

    return () => unsubscribe && unsubscribe();
  }, []);

  if (!currentIssue) return <div>Loading...</div>;

  return (
    <div>
      <h3>Current Issue:</h3>
      {/* Display current issue key and summary */}
      <p>
        <strong>{currentIssue.key}</strong>: {currentIssue.summary}
      </p>

      <h4>Top Similar Issues:</h4>

      {similarIssues.length > 0 ? (
        similarIssues.map((issue, index) => (
          <div key={issue.key} style={{ marginBottom: '1rem' }}>
            {/* Numbered list of similar issues with key and summary */}
            <strong>{index + 1}. {issue.key}</strong><br />
            Summary: {issue.summary}<br />
            {/* Similarity score rounded to two decimals */}
            Similarity Score: {issue.score?.toFixed(2) ?? 'N/A'}
          </div>
        ))
      ) : (
        <p>No similar issues found.</p>
      )}
    </div>
  );
}

export default App;
