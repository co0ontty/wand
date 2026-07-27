export function turnContentVolume(turn: any): number {
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

function mergeOverlappingTurns(localTurn: any, incomingTurn: any): any {
  if (localTurn?.role === "assistant" && incomingTurn?.role === "assistant") {
    return mergeAssistantTurn(localTurn, incomingTurn);
  }
  return incomingTurn || localTurn;
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
