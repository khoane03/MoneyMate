export type SplitMode = 'equal' | 'payer' | 'partner' | 'custom'

/** Allocate an integer VND total across any number of members without losing đồng. */
export function splitAmongMembers(total: bigint, participantIds: string[]) {
  const ids = [...new Set(participantIds)].sort()
  if (total <= 0n || ids.length === 0) throw new RangeError('Cần số tiền và ít nhất một thành viên.')
  const base = total / BigInt(ids.length)
  let remainder = total % BigInt(ids.length)
  return ids.map(id => {
    const amount = base + (remainder > 0n ? 1n : 0n)
    if (remainder > 0n) remainder -= 1n
    return { participantId: id, amount }
  })
}

/** Validate manual per-member VND allocations against the exact bill total. */
export function validateMemberAllocations(total: bigint, allocations: Array<{ participantId: string; amount: bigint }>) {
  if (total <= 0n || allocations.length === 0) throw new RangeError('Cần số tiền và ít nhất một thành viên.')
  const seen = new Set<string>()
  let allocated = 0n
  for (const item of allocations) {
    if (!item.participantId || seen.has(item.participantId) || item.amount < 0n) throw new RangeError('Phần chia thành viên không hợp lệ.')
    seen.add(item.participantId)
    allocated += item.amount
  }
  if (allocated !== total) throw new RangeError('Tổng phần chia phải bằng đúng tổng hóa đơn.')
  return allocations.filter(item => item.amount > 0n).sort((a, b) => a.participantId.localeCompare(b.participantId))
}

export function parsePercentBasisPoints(value: string) {
  const normalized=value.trim().replace(',','.')
  if(!/^\d{1,3}(?:\.\d{1,2})?$/.test(normalized)) throw new RangeError('Tỷ lệ cần từ 0% đến 100%, tối đa 2 chữ số thập phân.')
  const [whole='0',fraction='']=normalized.split('.')
  const points=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0')||'0')
  if(points>10000n) throw new RangeError('Tỷ lệ không được vượt 100%.')
  return points
}

export function splitByPercentages(total: bigint, percentages: Array<{participantId:string;basisPoints:bigint}>) {
  if(total<=0n||percentages.length===0) throw new RangeError('Cần số tiền và ít nhất một thành viên.')
  const seen=new Set<string>()
  let sum=0n
  const raw=percentages.map(item=>{
    if(!item.participantId||seen.has(item.participantId)||item.basisPoints<0n||item.basisPoints>10000n) throw new RangeError('Tỷ lệ thành viên không hợp lệ.')
    seen.add(item.participantId);sum+=item.basisPoints
    const numerator=total*item.basisPoints
    return {participantId:item.participantId,amount:numerator/10000n,remainder:numerator%10000n}
  })
  if(sum!==10000n) throw new RangeError('Tổng tỷ lệ cần bằng 100%.')
  let remaining=total-raw.reduce((value,item)=>value+item.amount,0n)
  const order=[...raw].sort((a,b)=>a.remainder===b.remainder?a.participantId.localeCompare(b.participantId):a.remainder>b.remainder?-1:1)
  for(const item of order){if(remaining<=0n)break;const target=raw.find(value=>value.participantId===item.participantId);if(target){target.amount+=1n;remaining-=1n}}
  return raw.map(({participantId,amount})=>({participantId,amount})).filter(item=>item.amount>0n).sort((a,b)=>a.participantId.localeCompare(b.participantId))
}

export function parseQuantityMilli(value: string): bigint {
  const normalized = value.trim().replace(',', '.')
  if (!/^\d{1,7}(?:\.\d{1,3})?$/.test(normalized)) throw new RangeError('Số lượng cần có tối đa 3 chữ số thập phân.')
  const [whole = '0', fraction = ''] = normalized.split('.')
  const result = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0') || '0')
  if (result <= 0n) throw new RangeError('Số lượng phải lớn hơn 0.')
  return result
}

export function calculateLineTotal(quantity: string, unitPrice: string): bigint {
  const milli = parseQuantityMilli(quantity)
  if (!/^(0|[1-9]\d{0,18})$/.test(unitPrice)) throw new RangeError('Đơn giá không hợp lệ.')
  const price = BigInt(unitPrice)
  if (price <= 0n) throw new RangeError('Đơn giá phải lớn hơn 0.')
  return (milli * price + 500n) / 1000n
}

export function splitLine(total: bigint, payerId: string, partnerId: string, mode: SplitMode, customPartnerShare = 0n) {
  if (total <= 0n || payerId === partnerId) throw new RangeError('Khoản chia không hợp lệ.')
  let partnerShare: bigint
  if (mode === 'payer') partnerShare = 0n
  else if (mode === 'partner') partnerShare = total
  else if (mode === 'custom') partnerShare = customPartnerShare
  else {
    partnerShare = total / 2n
    if (total % 2n === 1n && partnerId > payerId) partnerShare += 1n
  }
  if (partnerShare < 0n || partnerShare > total) throw new RangeError('Phần của người kia phải nằm trong tổng tiền món này.')
  return { payerShare: total - partnerShare, partnerShare }
}
