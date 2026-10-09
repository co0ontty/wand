/** Computed colors from fixture DOM, composited through solid ancestor surfaces. */
export function peopleContrastExpression(selectors: string[]): string {
  return `(()=>{
    const rgba=value=>{const numbers=value.match(/[\\d.]+/g)?.map(Number)||[];return [numbers[0]||0,numbers[1]||0,numbers[2]||0,numbers[3]??1]};
    const over=(front,back)=>front.slice(0,3).map((value,index)=>value*front[3]+back[index]*(1-front[3]));
    const luminance=color=>color.slice(0,3).map(value=>{const channel=value/255;return channel<=.04045?channel/12.92:Math.pow((channel+.055)/1.055,2.4)}).reduce((sum,value,index)=>sum+value*[.2126,.7152,.0722][index],0);
    return ${JSON.stringify(selectors)}.flatMap(selector=>Array.from(document.querySelectorAll(selector)).filter(node=>node.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&!node.closest('[inert],[hidden]')).slice(0,4).map(node=>{
      const ancestors=[];for(let current=node;current;current=current.parentElement)ancestors.unshift(current);
      let background=[255,255,255];for(const ancestor of ancestors)background=over(rgba(getComputedStyle(ancestor).backgroundColor),background);
      const style=getComputedStyle(node),foreground=over(rgba(style.color),background),a=luminance(foreground),b=luminance(background);
      return {selector,color:style.color,background:background.map(value=>Math.round(value)),fontSize:style.fontSize,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
    }));
  })()`;
}
