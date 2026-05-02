interface QuotationLike {
    units?: number;
    nano?: number;
}

export const quotationToNumber = (value: QuotationLike | undefined) => {
    if (!value) return undefined;
    return (value.units ?? 0) + (value.nano ?? 0) * 1e-9;
};
