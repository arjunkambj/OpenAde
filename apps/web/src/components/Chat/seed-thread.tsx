import { Activity, ActivityItem } from "@/components/Chat/activity";
import { ChangedFiles } from "@/components/Chat/changed-files";
import { FileTag } from "@/components/Chat/file-tag";
import { AssistantMessage, UserMessage } from "@/components/Chat/messages";

export function SeedThread() {
  return (
    <>
      <UserMessage>
        Soften the sidebar hover and keep the pressed state a little darker.
      </UserMessage>
      <AssistantMessage>
        <p>
          I’ll check how the sidebar handles hover, pressed, and selected states, then adjust the
          two interaction colors.
        </p>
      </AssistantMessage>
      <Activity>
        <ActivityItem icon="hugeicons:cloud" label="Thought for 3s">
          Activity summary: inspected the existing navigation styles and identified the hover and
          pressed rules.
        </ActivityItem>
        <ActivityItem icon="hugeicons:file-01" label="Read 2 files" defaultOpen>
          <pre className="font-mono text-xs leading-prose whitespace-pre-wrap">
            {`src/components/Sidebar.tsx
src/styles/sidebar.css
Read 2 files · Found hover, active, and focus-visible styles`}
          </pre>
        </ActivityItem>
        <ActivityItem
          icon="hugeicons:pencil-edit-02"
          label="Edited"
          files={["sidebar.css"]}
          stats="+2 −2"
        >
          Updated the hover and pressed background colors.
        </ActivityItem>
      </Activity>
      <AssistantMessage>
        <p>
          The pressed state was using Zinc 300, which explains the darker flash. I’m changing it to
          Zinc&nbsp;200 and softening hover to the custom Zinc 150 shade.
        </p>
      </AssistantMessage>
      <AssistantMessage>
        <p>
          Updated the sidebar interaction colors in <FileTag icon>sidebar.css</FileTag>. Hover is
          now Zinc 150, and pressing an item uses Zinc&nbsp;200.
        </p>
        <p>The item spacing, selected state, and keyboard focus outline are unchanged.</p>
      </AssistantMessage>
      <ChangedFiles folder="src/styles" file="sidebar.css" />
    </>
  );
}
