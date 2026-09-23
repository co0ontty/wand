function turnContentVolume(turn: any): number {
  if (!turn || !Array.isArray(turn.content)) return 0;
  var total = 0;
  for (var i = 0; i < turn.content.length; i++) {
    var block = turn.content[i];
    if (!block) continue;
    if (typeof block.text === "string") total += block.text.length;
    if (typeof block.thinking === "string") total += block.thinking.length;
    if (typeof block.content === "string") total += block.content.length;
    else if (Array.isArray(block.content)) {
      for (var k = 0; k < block.content.length; k++) {
        var nestedBlock = block.content[k];
        if (nestedBlock && typeof nestedBlock.text === "string") total += nestedBlock.text.length;
      }
    }
    if (block.input) {
      try {
        total += JSON.stringify(block.input).length;
      } catch (_error) {}
    }
  }
  return total;
}

export function mergeAssistantTurn(localTurn: any, incomingTurn: any): any {
  if (!localTurn) return incomingTurn;
  if (!incomingTurn) return localTurn;
  if (turnContentVolume(incomingTurn) >= turnContentVolume(localTurn)) return incomingTurn;
  return Object.assign({}, localTurn, {
    usage: incomingTurn.usage || localTurn.usage,
  });
}

/** A complete incremental turn supersedes a block-windowed tail, even if its text is shorter. */
export function mergeIncrementalWindowedTurn(localTurn: any, incomingTurn: any,
  leadingOffset: number, leadingTotal: number): any {
  if (leadingOffset > 0 && localTurn?.role === incomingTurn?.role
    && Array.isArray(incomingTurn?.content) && incomingTurn.content.length >= leadingTotal) {
    return incomingTurn;
  }
  return mergeAssistantTurn(localTurn, incomingTurn);
}

function mergeOverlappingTurns(localTurn: any, incomingTurn: any): any {
  if (localTurn?.role === "assistant" && incomingTurn?.role === "assistant") {
    return mergeAssistantTurn(localTurn, incomingTurn);
  }
  return incomingTurn || localTurn;
}

// Web block windows use the same cursor semantics as iOS: the first turn may
// contain only its last N blocks. Never treat that truncated turn as complete.
export function mergeBlockWindowedMessages(
  prev: any, incoming: any[], offset: number, total: number | undefined,
  leadingOffset: number, leadingTotal: number,
): { messages: any[]; messageOffset: number; messageTotal: number; leadingBlockOffset: number; leadingBlockTotal: number } {
  var prevOffset = prev && typeof prev.messageOffset === "number" ? prev.messageOffset : 0;
  var oldLeading = prev && typeof prev.leadingBlockOffset === "number" ? prev.leadingBlockOffset : 0;
  var oldTotal = prev && typeof prev.leadingBlockTotal === "number" ? prev.leadingBlockTotal : 0;
  var oldMessages = prev && Array.isArray(prev.messages) ? prev.messages : [];
  var snapTotal = typeof total === "number" ? total : offset + incoming.length;
  if (oldMessages.length && snapTotal < (prev.messageTotal || 0)) {
    return { messages: oldMessages, messageOffset: prevOffset, messageTotal: prev.messageTotal,
      leadingBlockOffset: oldLeading, leadingBlockTotal: oldTotal };
  }
  if (oldMessages.length && offset > prevOffset && leadingOffset > 0) {
    // The new first turn may already be fully cached in the older window.
    // Rebuild it before merging, otherwise a rolling 60-block window erases
    // previously paged turns each time the current turn grows.
    var cached = oldMessages[offset - prevOffset];
    var partial = incoming[0];
    if (cached?.role === partial?.role && Array.isArray(cached.content)
      && Array.isArray(partial.content) && cached.content.length >= leadingOffset
      && cached.content.length <= leadingTotal) {
      var content = cached.content.slice();
      partial.content.forEach(function(block: any, index: number) { content[leadingOffset + index] = block; });
      if (content.length >= leadingTotal && content.every(function(block: any) { return block !== undefined; })) {
        var complete = incoming.slice();
        complete[0] = Object.assign({}, partial, { content: content });
        var preserved = mergeWindowedMessages(prev, complete, offset, total);
        preserved.messages[offset - preserved.messageOffset] = complete[0];
        return { ...preserved, leadingBlockOffset: oldLeading, leadingBlockTotal: oldTotal };
      }
    }
    // No contiguous cached copy of the first turn: never claim the older
    // prefix is complete when the fresh window starts midway through a turn.
    return { messages: incoming, messageOffset: offset, messageTotal: snapTotal,
      leadingBlockOffset: leadingOffset, leadingBlockTotal: leadingTotal };
  }
  var replacement = incoming;
  var joinedFirst = false;
  var resolvedLeading = leadingOffset;
  var resolvedTotal = leadingTotal;
  if (oldMessages.length && incoming.length && offset === prevOffset) {
    var oldFirst = oldMessages[0];
    var newFirst = incoming[0];
    if (oldFirst?.role === newFirst?.role && Array.isArray(oldFirst.content) && Array.isArray(newFirst.content)) {
      var start = Math.min(oldLeading, leadingOffset);
      var end = Math.max(oldLeading + oldFirst.content.length, leadingOffset + newFirst.content.length);
      var blocks = new Array(end - start);
      oldFirst.content.forEach(function(block: any, index: number) { blocks[oldLeading + index - start] = block; });
      newFirst.content.forEach(function(block: any, index: number) { blocks[leadingOffset + index - start] = block; });
      // A gap means the two windows cannot be safely spliced together.
      if (blocks.every(function(block) { return block !== undefined; })) {
        replacement = incoming.slice();
        replacement[0] = Object.assign({}, newFirst, { content: blocks });
        joinedFirst = true;
        resolvedLeading = start;
        resolvedTotal = Math.max(oldTotal, leadingTotal, end);
      }
    }
  }
  var merged = mergeWindowedMessages(prev, replacement, offset, total);
  // A joined block range is known to be contiguous; the generic volume-based
  // assistant merge may otherwise keep only the truncated old tail.
  if (joinedFirst && merged.messageOffset === offset) merged.messages[0] = replacement[0];
  if (merged.messageOffset < offset) {
    resolvedLeading = oldLeading;
    resolvedTotal = oldTotal;
  }
  return { ...merged, leadingBlockOffset: resolvedLeading, leadingBlockTotal: resolvedTotal };
}

export function mergeWindowedMessages(prev: any, incoming: any[], offset: number, total?: number): {
  messages: any[];
  messageOffset: number;
  messageTotal: number;
} {
  var snapOffset = offset || 0;
  var snapTotal = typeof total === "number"
    ? total
    : Math.max(snapOffset + incoming.length, incoming.length);
  var prevMsgs = prev && Array.isArray(prev.messages) ? prev.messages : [];
  var prevOffset = prev && typeof prev.messageOffset === "number" ? prev.messageOffset : 0;
  var prevTotal = prev && typeof prev.messageTotal === "number"
    ? prev.messageTotal
    : prevOffset + prevMsgs.length;

  if (incoming.length === 0 && prevMsgs.length > 0 && snapTotal === 0) {
    return { messages: prevMsgs, messageOffset: prevOffset, messageTotal: prevTotal };
  }
  if (prevMsgs.length > 0 && snapTotal < prevTotal) {
    return { messages: prevMsgs, messageOffset: prevOffset, messageTotal: prevTotal };
  }
  if (prevMsgs.length === 0) {
    return { messages: incoming, messageOffset: snapOffset, messageTotal: snapTotal };
  }

  var prevEnd = prevOffset + prevMsgs.length;
  var snapEnd = snapOffset + incoming.length;
  if (snapOffset > prevEnd || prevOffset > snapEnd) {
    return { messages: incoming, messageOffset: snapOffset, messageTotal: snapTotal };
  }

  var mergedOffset = Math.min(prevOffset, snapOffset);
  var mergedEnd = Math.max(prevEnd, snapEnd);
  var merged: any[] = [];
  for (var absoluteIndex = mergedOffset; absoluteIndex < mergedEnd; absoluteIndex++) {
    var localTurn = absoluteIndex >= prevOffset && absoluteIndex < prevEnd
      ? prevMsgs[absoluteIndex - prevOffset]
      : undefined;
    var incomingTurn = absoluteIndex >= snapOffset && absoluteIndex < snapEnd
      ? incoming[absoluteIndex - snapOffset]
      : undefined;
    merged.push(mergeOverlappingTurns(localTurn, incomingTurn));
  }

  return {
    messages: merged,
    messageOffset: mergedOffset,
    messageTotal: Math.max(prevTotal, snapTotal, mergedOffset + merged.length),
  };
}
