export type OtType = "D" | "N" | "A";

export interface Profile {
  userId: number;
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  salaryCents: number | null;
}

export interface OtRecord {
  id: number;
  userId: number;
  date: string;
  startTime: string;
  endTime: string;
  otType: OtType;
  hours: number;
  breakHours: number;
  paidHours: number;
  rateCents: number;
  amountCents: number;
}

export interface MonthTotals {
  count: number;
  paidHours: number;
  amountCents: number;
}

export interface OtComputed {
  hours: number;
  breakHours: number;
  paidHours: number;
  rateCents: number;
  amountCents: number;
}

export interface OtState {
  flow: "ot" | "salary";
  step: "type" | "date" | "time" | "confirm" | "salary";
  otType?: OtType;
  date?: string;
  startTime?: string;
  endTime?: string;
  computed?: OtComputed;
}