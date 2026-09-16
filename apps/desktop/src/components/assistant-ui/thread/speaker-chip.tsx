import { SCAFFOLD_LABEL_CLASS } from '@/components/chat/scaffold-row'
import type { SpeakerIdentity } from '@/lib/chat-identity'

/**
 * "Who spoke" chip above a bubble: a round avatar (image, glyph, or the name's
 * first character) followed by the speaker's name. Shared by the human and
 * assistant bubbles so one transcript reads like a group chat.
 */
export function SpeakerChip({ avatar, avatarImage, name }: SpeakerIdentity) {
  return (
    <div className="mb-1 flex items-center gap-1.5" data-slot="aui_speaker-chip">
      <span
        aria-hidden="true"
        className="inline-grid size-4 shrink-0 place-items-center overflow-hidden rounded-full bg-(--ui-bg-tertiary) text-[0.625rem] leading-none text-(--ui-text-secondary)"
        data-slot="aui_speaker-avatar"
      >
        {avatarImage ? (
          <img alt="" className="size-full object-cover" src={avatarImage} />
        ) : (
          (avatar ?? name.charAt(0))
        )}
      </span>
      <span className={`${SCAFFOLD_LABEL_CLASS} font-medium`}>{name}</span>
    </div>
  )
}
