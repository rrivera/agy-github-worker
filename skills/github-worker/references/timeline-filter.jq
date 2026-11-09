# Merged Issue + PR Timeline jq Filter
# Usage: jq -n --argjson issues "$ISSUES_JSON" --argjson prs "$PRS_JSON" --argjson inlines "$INLINE_COMMENTS_JSON" --argjson targets "$TARGET_ISSUES_JSON" -f references/timeline-filter.jq

$issues | map(
  . as $issue |
  select(($targets | length == 0) or ($targets | index($issue.number))) |
  ("feat/issue-" + ($issue.number | tostring)) as $branch |
  ($prs | map(select(.headRefName == $branch)) | .[0] // null) as $pr |
  ($issue.labels | map(.name)) as $labels |
  (
    if ($labels | index("status:done")) then "Done"
    elif ($labels | index("status:in-review")) then "In Review"
    elif ($labels | index("status:in-progress")) then "In Progress"
    elif ($labels | index("status:waiting-on-user")) then "Waiting on User"
    else "Todo"
    end
  ) as $status |
  select($status != "Done") |
  (
    [
      ($issue.comments // [] | map({
        source: "issue_comment",
        author: .author.login,
        body: (.body // ""),
        timestamp: .createdAt
      })),
      ($pr.comments // [] | map({
        source: "pr_comment",
        author: .author.login,
        body: (.body // ""),
        timestamp: .createdAt
      })),
      ($inlines // [] | map(
        select($pr != null and ((.pull_request_url // "") | endswith("/" + ($pr.number | tostring)))) | {
          source: "pr_inline_comment",
          author: .user.login,
          body: (.body // ""),
          timestamp: .created_at
        }
      )),
      ($pr.reviews // [] | map(select((.body // "") != "" or .state == "APPROVED" or .state == "CHANGES_REQUESTED") | {
        source: "pr_review",
        author: .author.login,
        state: .state,
        body: (.body // ""),
        timestamp: (.submittedAt // .createdAt)
      }))
    ]
    | flatten
    | map(select(.timestamp != null))
    | sort_by(.timestamp)
    | map(. + {
        is_agent: (.body | contains("<!-- antigravity-agent:")),
        requests_changes: (
          (.body | contains("<!-- antigravity-agent:")) and
          ((.body | contains("verdict=REQUEST_CHANGES")) or (.body | contains("Verdict: REQUEST_CHANGES")) or (.state == "CHANGES_REQUESTED"))
        )
      })
  ) as $timeline |
  ($timeline | map(.is_agent) | rindex(true)) as $last_agent_idx |
  (if $last_agent_idx == null then null else $timeline[$last_agent_idx] end) as $last_agent_event |
  (if $last_agent_idx == null then $timeline else $timeline[($last_agent_idx + 1):] end | map(select(.is_agent | not))) as $latest_human |
  (
    if $status == "Todo" then
      if $last_agent_idx == null then "NEEDS_PLAN"
      elif ($latest_human | length) > 0 then "USER_REPLIED"
      else "WAITING_ON_USER"
      end
    elif ($latest_human | length) > 0 then "USER_REPLIED"
    elif ($status == "In Progress" and $last_agent_idx == null) then "NEEDS_PLAN"
    elif ($status == "In Progress" and ($last_agent_event.requests_changes // false)) then "NEEDS_REVISION"
    else "WAITING_ON_USER"
    end
  ) as $action |
  {
    issue_number: $issue.number,
    title: $issue.title,
    url: $issue.url,
    body: $issue.body,
    status: $status,
    labels: $labels,
    pr_number: ($pr.number // null),
    actionable: ($action != "WAITING_ON_USER"),
    action: $action,
    latest_human_comments: $latest_human
  }
)
